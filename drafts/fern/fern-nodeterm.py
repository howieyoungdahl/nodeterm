#!/usr/bin/env python3
"""Local operator CLI for the user's NodeTerm terminals; no browser session required."""
import argparse
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
import queue
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class ControlError(Exception):
    pass


class HTTPControlError(ControlError):
    def __init__(self, status, payload):
        self.status = status
        # Never echo an arbitrary server body, which may contain command or credential bytes.
        safe_codes = {'idempotency_key_reused', 'revision_conflict', 'unauthorized', 'unsupported',
                      'invalid_idempotency_key', 'not_found', 'creation_outcome_uncertain',
                      'launch_outcome_uncertain_do_not_repeat'}
        self.code = payload.get('error') if isinstance(payload, dict) else None
        if not isinstance(self.code, str) or self.code not in safe_codes:
            self.code = None
        self.node_id = payload.get('id') if isinstance(payload, dict) else None
        if not safe_id(self.node_id):
            self.node_id = None
        super().__init__('NodeTerm returned HTTP %s%s' % (status, ': ' + self.code if self.code else ''))


class CreationUncertain(ControlError):
    def __init__(self, details):
        self.details = details
        super().__init__('Creation outcome is uncertain; inspect the same key without repeating POST.')


class CleanupUncertain(ControlError):
    def __init__(self, details):
        self.details = details
        super().__init__('Cleanup outcome is uncertain; inspect its receipt without repeating the mutation.')


FORBIDDEN_LABELS = {'__proto__', 'constructor', 'prototype'}
REQUEST_TIMEOUT = 20
# The server's external launch deadline is 30 seconds; allow its final response to arrive.
CREATE_TIMEOUT = 35
CLEANUP_TIMEOUT = 30
CLEANUP_BYTES = 1_048_576
DISPOSITIONS = {'obsolete-completed', 'obsolete-superseded', 'obsolete-paused', 'obsolete-shell'}


def cleanup_uuid(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value) is not None


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def reviewed_cleanup_body(value):
    if (not isinstance(value, dict) or set(value) != {'projectId', 'entries'} or not safe_id(value['projectId'])
            or not isinstance(value['entries'], list) or not 1 <= len(value['entries']) <= 100):
        raise ControlError('Cleanup requires one exact project and 1 to 100 explicitly reviewed entries.')
    seen = set()
    for entry in value['entries']:
        if (not isinstance(entry, dict) or set(entry) != {'nodeId', 'disposition', 'ownerDigest', 'evidenceDigest'}
                or not safe_id(entry['nodeId']) or entry['nodeId'] in seen
                or not isinstance(entry['disposition'], str) or entry['disposition'] not in DISPOSITIONS
                or not digest(entry['ownerDigest']) or not digest(entry['evidenceDigest'])):
            raise ControlError('Cleanup needs unique exact IDs, explicit dispositions and current evidence/owner digests.')
        seen.add(entry['nodeId'])
    if len(json.dumps(value).encode('utf-8')) > 64_000:
        raise ControlError('Cleanup request exceeds the server 64,000-byte budget.')
    return value


def cleanup_receipt(value, receipt_id=None):
    receipt = value.get('receipt') if isinstance(value, dict) and type(value.get('version')) is int and value['version'] == 1 else None
    if (not isinstance(receipt, dict) or set(receipt) - {'version', 'id', 'planId', 'at', 'state', 'items', 'review'}
            or type(receipt.get('version')) is not int or receipt['version'] != 1
            or not cleanup_uuid(receipt.get('id')) or (receipt_id is not None and receipt['id'] != receipt_id)
            or not cleanup_uuid(receipt.get('planId')) or type(receipt.get('at')) is not int or receipt['at'] <= 0
            or not isinstance(receipt.get('state'), str) or receipt['state'] not in {'prepared', 'applied', 'undo-prepared', 'undone'}
            or not isinstance(receipt.get('items'), list) or not 1 <= len(receipt['items']) <= 100):
        raise ControlError('Invalid cleanup receipt; outcome remains unknown.')
    seen = set()
    for item in receipt['items']:
        if (not isinstance(item, dict) or set(item) != {'projectId', 'nodeId', 'generation', 'before', 'after'}
                or not safe_id(item['projectId']) or not safe_id(item['nodeId']) or item['nodeId'] in seen
                or not isinstance(item['generation'], str) or not 1 <= len(item['generation']) <= 16_384
                or not digest(item['before']) or not digest(item['after'])):
            raise ControlError('Invalid cleanup receipt cohort; outcome remains unknown.')
        seen.add(item['nodeId'])
    if 'review' in receipt:
        reviewed_cleanup_body({'projectId': receipt['items'][0]['projectId'], 'entries': receipt['review']})
        if ([e['nodeId'] for e in receipt['review']] != [i['nodeId'] for i in receipt['items']]
                or any(i['projectId'] != receipt['items'][0]['projectId'] for i in receipt['items'])):
            raise ControlError('Invalid reviewed receipt scope; outcome remains unknown.')
    return receipt


def read_cleanup_request(file):
    source = Path(file)
    if not source.is_absolute() or not source.is_file():
        raise ControlError('Cleanup request must be an absolute regular host file.')
    with source.open('rb') as stream:
        raw = stream.read(64_001)
    if len(raw) > 64_000:
        raise ControlError('Cleanup request exceeds the server 64,000-byte budget.')
    return reviewed_cleanup_body(json.loads(raw.decode('utf-8-sig')))


@contextmanager
def cleanup_record(output):
    dest = Path(output)
    if not dest.is_absolute():
        raise ControlError('Cleanup receipt output must be an absolute host path.')
    # Reserve before any POST; never overwrite an earlier packet or receipt.
    with dest.open('x', encoding='utf-8') as stream:
        os.chmod(dest, 0o600)
        def write(value):
            body = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
            stream.seek(0); stream.write(body); stream.truncate(); stream.flush(); os.fsync(stream.fileno())
            if dest.read_text(encoding='utf-8') != body:
                raise ControlError('Cleanup receipt verification failed; execution outcome must be reconciled.')
        yield write


def safe_id(value):
    return (isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9._-]{1,128}', value) is not None
            and value not in FORBIDDEN_LABELS | {'.', '..'})


def validate_creation_key(value):
    if (not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9._-]{8,128}', value) is None
            or value in FORBIDDEN_LABELS):
        raise ControlError('Idempotency key must be 8 to 128 ASCII letters/digits/./_/-; retain it across retries.')
    return value


def spawn_body(project_id, title, cwd='/tmp', owner=None, workstream=None, functional_role=None,
               idempotency_key=None, task_id=None, task_planning=None):
    # All shared-management creation is explicitly task managed; the token does not name Fern.
    if any(value is None for value in (owner, workstream, functional_role, idempotency_key, task_id)):
        raise ControlError('Spawn requires task ID, creation key, declared owner and complete explicit organization.')
    validate_creation_key(task_id)
    body = {'projectId': project_id, 'title': title, 'cwd': cwd, 'cmd': 'exec bash --noprofile --norc'}
    if idempotency_key is not None:
        body['idempotencyKey'] = validate_creation_key(idempotency_key)
    if any(value is not None for value in (owner, workstream, functional_role)):
        if any(value is None for value in (owner, workstream, functional_role)):
            raise ControlError('Organized spawn requires --owner, --workstream and explicit --functional-role.')
        if idempotency_key is None:
            raise ControlError('Organized spawn requires a caller-provided stable --idempotency-key.')
        if not safe_id(project_id):
            raise ControlError('Organized spawn requires an exact valid project ID.')
        # Match the server codec, including its UTF-16 length cap for a descriptive owner.
        if (not isinstance(owner, str) or not owner or
                len(owner.encode('utf-16-le', 'surrogatepass')) // 2 > 160 or
                re.search(r'[\x00-\x1f\x7f]', owner)):
            raise ControlError('Owner must contain 1 to 160 printable characters.')
        for name, value in (('workstream', workstream), ('functional role', functional_role)):
            if (not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9._-]{1,80}', value) is None
                    or value in FORBIDDEN_LABELS):
                raise ControlError('Invalid %s: use 1 to 80 ASCII letters/digits/./_/-.' % name)
        body['organization'] = {'owner': owner, 'projectId': project_id,
                                'workstream': workstream, 'functionalRole': functional_role}
    body['creation'] = {'version': 1, 'taskId': task_id, 'creationId': idempotency_key, 'declaredOwner': owner}
    if task_planning is not None:
        if not isinstance(task_planning, dict) or task_planning.get('taskId') != task_id:
            raise ControlError('Task planning must be an object matching the exact declared task ID.')
        body['creation']['planning'] = task_planning
    return body


def posix_path(value):
    if re.match(r'^[A-Za-z]:[\\/]', value):
        return '/mnt/' + value[0].lower() + '/' + value[3:].replace('\\', '/')
    return value


# No target, body or operation reaches this process until the Windows caller receives readiness.
# Retrying a WSL service startup timeout is safe here because the helper has not been invoked.
WSL_BOOTSTRAP = '''import json, runpy, sys
sys.stdout.buffer.write(('FERN_NODETERM_READY:' + sys.argv[2] + '\\n').encode())
sys.stdout.buffer.flush()
line = sys.stdin.buffer.readline(1048577)
if not line:
    sys.exit(0)
arguments = json.loads(line)
if not isinstance(arguments, list) or not all(isinstance(v, str) for v in arguments):
    sys.exit(2)
script = sys.argv[1]
sys.argv = [script, *arguments]
runpy.run_path(script, run_name='__main__')
'''


def windows_stdin_required(arguments):
    # Only the positional command following the global options selects stdin delivery.
    index = 0
    while index < len(arguments):
        value = arguments[index]
        if value in ('--url', '--socket', '--data-dir'):
            index += 2
        elif any(value.startswith(flag + '=') for flag in ('--url', '--socket', '--data-dir')):
            index += 1
        else:
            return value == 'send' and not any(arg == '--body-file' or arg.startswith('--body-file=')
                                              for arg in arguments[index + 1:])
    return False


def run_windows(arguments, body=b'', *, popen=None, startup_timeout=12):
    launch = popen or subprocess.Popen
    payload = json.dumps([posix_path(value) for value in arguments]).encode() + b'\n' + body
    for attempt in range(2):
        nonce = uuid.uuid4().hex
        ready = ('FERN_NODETERM_READY:' + nonce + '\n').encode()
        process = launch(['wsl.exe', '-d', 'Ubuntu', '--exec', 'python3', '-u', '-c', WSL_BOOTSTRAP,
                          posix_path(str(Path(__file__).resolve())), nonce],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        observed = queue.Queue(maxsize=1)

        def read_ready(child=process, expected=ready, output=observed):
            try:
                result = b''
                while len(result) < len(expected):
                    chunk = child.stdout.read(len(expected) - len(result))
                    if not chunk:
                        break
                    result += chunk
                output.put(result)
            except OSError:
                output.put(b'')

        reader = threading.Thread(target=read_ready, daemon=True)
        reader.start()
        timed_out = False
        try:
            greeting = observed.get(timeout=startup_timeout)
        except queue.Empty:
            greeting = b''
            timed_out = True
        if greeting == ready:
            # After dispatch, never retry, even if the command reports the same WSL error.
            stdout, stderr = process.communicate(payload)
            return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
        # We own only this launcher. Close its empty input and stop it, never the WSL service.
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        reader.join(timeout=1)
        stdout, stderr = process.communicate(timeout=5)
        diagnostic = (greeting + stdout + stderr).replace(b'\x00', b'').lower()
        transient = timed_out or b'0x8007274c' in diagnostic
        if attempt == 0 and transient:
            time.sleep(0.5)
            continue
        raise ControlError('WSL startup unavailable before command dispatch; nothing was sent. '
                           'No target, input, permission or service was changed.')


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


class NodeTerm:
    def __init__(self, args):
        parsed = urllib.parse.urlsplit(args.url)
        if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
                or parsed.username or parsed.password or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment):
            raise ControlError('The management credential can only be used on a loopback HTTP URL.')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', args.socket):
            raise ControlError('Invalid tmux socket name.')
        self.url = args.url.rstrip('/')
        self.socket = args.socket
        token_file = Path(args.data_dir) / 'ops-token'
        info = token_file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ControlError('The operator token must be a regular, owner-only file owned by this user.')
        self.token = token_file.read_text().strip()
        if not self.token or '\n' in self.token or '\r' in self.token:
            raise ControlError('Invalid operator credential file.')

    def request(self, route, method='GET', body=None, *, timeout=REQUEST_TIMEOUT, max_bytes=None):
        data = None if body is None else json.dumps(body).encode('utf-8')
        headers = {'Authorization': 'Bearer ' + self.token}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.url + '/opsapi/' + route, data=data,
                                         headers=headers, method=method)
        # Do not follow redirects or route this loopback credential through an HTTP proxy.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *unused):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=timeout) as reply:
                if max_bytes is not None:
                    raw = reply.read(max_bytes + 1)
                    if len(raw) > max_bytes:
                        raise ControlError('NodeTerm cleanup response exceeds its 1 MiB budget.')
                    try:
                        return json.loads(raw)
                    except RecursionError:
                        raise ControlError('Invalid cleanup response nesting; execution outcome remains unknown.') from None
                return json.load(reply)
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read(4096))
            except (OSError, ValueError, RecursionError, http.client.HTTPException):
                payload = None
            finally:
                error.close()
            raise HTTPControlError(error.code, payload) from None

    def cleanup_preview(self):
        result = self.request('cleanup/preview', timeout=CLEANUP_TIMEOUT, max_bytes=CLEANUP_BYTES)
        if (not isinstance(result, dict) or type(result.get('version')) is not int or result['version'] != 1
                or result.get('dryRun') is not True or not isinstance(result.get('plan'), dict)
                or not isinstance(result['plan'].get('rows'), list)):
            raise ControlError('Invalid cleanup preview; nothing was archived.')
        return result

    def cleanup_receipt(self, receipt_id):
        if not cleanup_uuid(receipt_id):
            raise ControlError('An exact cleanup receipt UUID is required.')
        result = self.request('cleanup/receipts/' + receipt_id, max_bytes=CLEANUP_BYTES)
        cleanup_receipt(result, receipt_id)
        return result

    def cleanup_receipts(self):
        result = self.request('cleanup/receipts', max_bytes=CLEANUP_BYTES)
        ids = result.get('receiptIds') if isinstance(result, dict) else None
        if (not isinstance(result, dict) or type(result.get('version')) is not int or result['version'] != 1
                or not isinstance(ids, list) or len(ids) > 1000 or any(not cleanup_uuid(i) for i in ids)
                or len(set(ids)) != len(ids)):
            raise ControlError('Invalid cleanup receipt listing; execution outcome remains unknown.')
        return result

    def _cleanup_mutation(self, route, body, record, context, validate):
        record({**context, 'phase': 'requesting', 'outcomeKnown': False})
        result = None
        try:
            result = self.request(route, 'POST', body, timeout=CLEANUP_TIMEOUT, max_bytes=CLEANUP_BYTES)
            receipt = validate(result)
            verified = {**context, 'phase': 'verified', 'outcomeKnown': True, 'receipt': receipt}
            record(verified)
            return verified
        except HTTPControlError as error:
            if error.status in (401, 403):
                record({**context, 'phase': 'refused', 'httpStatus': error.status, 'outcomeKnown': True})
                raise  # No secondary read after an authorization refusal.
            failure = {'httpStatus': error.status, 'errorType': type(error).__name__}
        except (ControlError, OSError, ValueError, http.client.HTTPException) as error:
            failure = {'errorType': type(error).__name__}
        details = {**context, 'phase': 'outcome-unknown', 'outcomeKnown': False, **failure}
        receipt_id = context.get('receiptId')
        if (receipt_id is None and isinstance(result, dict) and isinstance(result.get('receipt'), dict)
                and cleanup_uuid(result['receipt'].get('id'))):
            receipt_id = result['receipt']['id']
        try:
            # One read-only reconciliation attempt, never a mutation retry or Close fallback.
            details['reconciliation'] = self.cleanup_receipt(receipt_id) if receipt_id else self.cleanup_receipts()
        except (ControlError, OSError, ValueError, http.client.HTTPException) as error:
            details['reconciliationErrorType'] = type(error).__name__
        try:
            record(details)
        except (ControlError, OSError) as error:
            details['localReceiptWriteErrorType'] = type(error).__name__
        raise CleanupUncertain(details)

    def cleanup(self, reviewed, output):
        reviewed = reviewed_cleanup_body(reviewed)
        entries = reviewed['entries']
        selected = {e['nodeId']: e for e in entries}
        context = {'version': 1, 'operation': 'archive', 'projectId': reviewed['projectId'],
                   'nodeIds': list(selected), 'review': entries, 'receiptFile': str(output)}
        with cleanup_record(output) as record:
            record({**context, 'phase': 'reviewed-request', 'outcomeKnown': True, 'archiveRequested': False})
            preview = self.request('cleanup/reviewed-preview', 'POST', reviewed,
                                   timeout=CLEANUP_TIMEOUT, max_bytes=CLEANUP_BYTES)
            plan = preview.get('plan') if isinstance(preview, dict) else None
            now = int(time.time() * 1000)
            if (not isinstance(preview, dict) or type(preview.get('version')) is not int or preview['version'] != 1
                    or preview.get('dryRun') is not True or not isinstance(plan, dict)
                    or not cleanup_uuid(plan.get('id')) or plan.get('mode') != 'operator-reviewed'
                    or not digest(plan.get('workspaceHash')) or type(plan.get('createdAt')) is not int
                    or type(plan.get('expiresAt')) is not int or not 0 < plan['createdAt'] <= now < plan['expiresAt']
                    or plan['expiresAt'] - plan['createdAt'] != 300_000 or not isinstance(plan.get('rows'), list)):
                raise ControlError('Fresh exact reviewed cleanup preview required; nothing was archived.')
            eligible = [row for row in plan['rows'] if isinstance(row, dict) and row.get('eligible') is True]
            if (len(eligible) != len(selected) or any(not safe_id(r.get('nodeId')) for r in eligible)
                    or {r.get('nodeId') for r in eligible} != set(selected)):
                raise ControlError('Reviewed cleanup cohort mismatch; nothing was archived.')
            generations = {}
            for node_id, entry in selected.items():
                rows = [r for r in plan['rows'] if isinstance(r, dict) and r.get('nodeId') == node_id]
                row = rows[0] if len(rows) == 1 else {}
                fence = row.get('reviewedFence') or {}
                evidence = row.get('evidence')
                generation = evidence.get('generation') if isinstance(evidence, dict) else None
                row_review = {k: entry[k] for k in ('disposition', 'evidenceDigest', 'ownerDigest')}
                if (row.get('projectId') != reviewed['projectId'] or row.get('archived') is not False
                        or row.get('eligible') is not True or row.get('review') != row_review
                        or not isinstance(fence, dict) or fence.get('admissible') is not True
                        or fence.get('ownerDigest') != entry['ownerDigest'] or not isinstance(generation, str)
                        or not generation or generation != fence.get('generation')):
                    raise ControlError('Reviewed cleanup identity/owner evidence changed; nothing was archived.')
                generations[node_id] = generation
            context['planId'] = plan['id']
            def validate(result):
                receipt = cleanup_receipt(result)
                if (receipt['state'] != 'applied' or receipt['planId'] != plan['id'] or receipt.get('review') != entries
                        or [i['nodeId'] for i in receipt['items']] != list(selected)
                        or any(i['projectId'] != reviewed['projectId'] or i['generation'] != generations[i['nodeId']]
                               for i in receipt['items'])):
                    raise ControlError('Exact archive acknowledgment mismatch; outcome remains unknown.')
                return receipt
            return self._cleanup_mutation('cleanup/archive', {'planId': plan['id'], 'nodeIds': list(selected)},
                                          record, context, validate)

    def cleanup_undo(self, receipt_id, output):
        if not cleanup_uuid(receipt_id):
            raise ControlError('An exact cleanup receipt UUID is required.')
        with cleanup_record(output) as record:
            context = {'version': 1, 'operation': 'undo', 'receiptId': receipt_id, 'receiptFile': str(output)}
            record({**context, 'phase': 'receipt-read', 'outcomeKnown': True, 'undoRequested': False})
            original = cleanup_receipt(self.cleanup_receipt(receipt_id), receipt_id)
            context['nodeIds'] = [i['nodeId'] for i in original['items']]
            if original['state'] == 'undone':
                result = {**context, 'phase': 'verified', 'outcomeKnown': True, 'receipt': original}
                record(result)
                return result
            def validate(result):
                receipt = cleanup_receipt(result, receipt_id)
                if (receipt['state'] != 'undone' or receipt['planId'] != original['planId']
                        or receipt['items'] != original['items'] or receipt.get('review') != original.get('review')):
                    raise ControlError('Exact undo acknowledgment mismatch; outcome remains unknown.')
                return receipt
            return self._cleanup_mutation('cleanup/undo', {'receiptId': receipt_id}, record, context, validate)

    def receipt(self, key):
        key = validate_creation_key(key)
        try:
            result = self.request('creation-receipts/' + urllib.parse.quote(key, safe=''))
        except HTTPControlError:
            raise
        except (OSError, ValueError, http.client.HTTPException) as error:
            raise ControlError('Receipt read failed (%s); outcome remains unknown.' % type(error).__name__) from None
        if isinstance(result, dict) and result.get('error') == 'creation_receipt_not_found':
            # This single observation is not proof that a timed-out create never reached the server.
            return {'idempotencyKey': key, 'error': 'creation_receipt_not_found', 'outcomeKnown': False}
        if (not isinstance(result, dict) or result.get('idempotencyKey') != key or
                not safe_id(result.get('id')) or not safe_id(result.get('projectId')) or
                result.get('stage') not in ('reserved', 'launch_claimed', 'finished') or
                'outcome' not in result or result['outcome'] not in
                (None, 'success', 'spawn_failed', 'command_failed', 'uncertain')):
            raise ControlError('Invalid or unavailable creation receipt; outcome remains unknown.')
        return {name: result[name] for name in ('idempotencyKey', 'id', 'projectId', 'stage', 'outcome')}

    def uncertain_creation(self, key, project_id, failure, node_id=None):
        details = {'error': 'creation_outcome_uncertain_inspect_receipt', 'idempotencyKey': key,
                   'postFailure': failure, 'launchSuccessVerified': False, 'requestedContentVerified': False}
        if node_id:
            details['partialNodeId'] = node_id
        try:
            # Exactly one read-only recovery attempt. Never replay POST or replace the key.
            details['receipt'] = self.receipt(key)
            if 'projectId' in details['receipt']:
                details['receiptProjectMatchesRequest'] = details['receipt']['projectId'] == project_id
        except (ControlError, OSError, ValueError, http.client.HTTPException) as error:
            # Error types/status are safe diagnostics; arbitrary transport bodies are not.
            details['receiptReadFailure'] = ('HTTP %s' % error.status if isinstance(error, HTTPControlError)
                                             else type(error).__name__)
        # GET exposes no fingerprint. Even finished/success cannot authenticate this submitted body.
        raise CreationUncertain(details) from None

    def spawn(self, project_id, title, cwd='/tmp', owner=None, workstream=None, functional_role=None,
              idempotency_key=None, task_id=None, task_planning=None):
        body = spawn_body(project_id, title, cwd, owner, workstream, functional_role, idempotency_key, task_id, task_planning)
        # Read-only mixed-version admission. A 404, old shape, transport failure or weaker
        # promise stops locally before POST; it cannot create an uncertain launch to recover.
        try:
            contract = self.request('creation-contract')
        except (ControlError, OSError, ValueError, http.client.HTTPException):
            raise ControlError('Assistant creation contract unavailable; no launch POST was made.') from None
        expected = {'version': 1, 'taskId': 'required', 'creationKey': 'exact-required',
                    'metadata': 'owner-project-workstream-functionalRole-required',
                    'privateReceipt': 'before-save-and-spawn', 'verifiedCreatorSource': True,
                    'taskPlanning': 'category-urgency-reason-relationship-before-save-and-spawn'}
        promise = contract.get('assistantCreation') if isinstance(contract, dict) else None
        publication = contract.get('receiptPublication') if isinstance(contract, dict) else None
        receipt_platform = publication.get('platform') if isinstance(publication, dict) else None
        supported_platforms = ('aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd')
        if (not isinstance(contract, dict) or type(contract.get('version')) is not int or contract['version'] != 1 or
                not isinstance(promise, dict) or type(promise.get('version')) is not int or
                promise.get('verifiedCreatorSource') is not True or promise != expected or
                not isinstance(publication, dict) or type(publication.get('version')) is not int or publication['version'] != 1 or
                receipt_platform not in supported_platforms or publication.get('guarantee') !=
                ('file-flush-visibility' if receipt_platform == 'win32' else 'file-and-directory-sync')):
            raise ControlError('Assistant creation contract incompatible; no launch POST was made.')
        try:
            result = self.request('nodes', 'POST', body, timeout=CREATE_TIMEOUT)
            if (not isinstance(result, dict) or not safe_id(result.get('id')) or
                    result.get('projectId') != project_id or result.get('error') or
                    (idempotency_key is not None and result.get('idempotencyKey') != idempotency_key)):
                raise ValueError('invalid_creation_response')
            return result
        except HTTPControlError as error:
            if idempotency_key is not None and (error.status >= 500 or
                    error.code in ('launch_outcome_uncertain_do_not_repeat', 'creation_outcome_uncertain')):
                self.uncertain_creation(idempotency_key, project_id, 'HTTP %s' % error.status, error.node_id)
            raise
        except (OSError, ValueError, http.client.HTTPException) as error:
            if idempotency_key is not None:
                self.uncertain_creation(idempotency_key, project_id, type(error).__name__)
            raise ControlError('Spawn transport/response failed; outcome unknown. No automatic retry was made.') from None

    def tmux(self, *args, input_bytes=None):
        process = subprocess.run(['tmux', '-L', self.socket, *args], input=input_bytes,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        if process.returncode:
            raise ControlError('tmux failed: ' + process.stderr.decode('utf-8', 'replace').strip())
        return process.stdout.decode('utf-8', 'replace')

    def panes(self):
        # Multiple panes for one card are ambiguous: never pick one silently.
        rows = self.tmux('list-panes', '-a', '-F',
                         '#{session_name}\t#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}')
        result = {}
        for row in rows.splitlines():
            fields = row.split('\t')
            if len(fields) != 6:
                continue
            name, created, pane, pid, dead, command = fields
            result.setdefault(name, []).append({'sessionName': name, 'sessionCreated': created,
                                                'paneId': pane, 'panePid': pid,
                                                'paneDead': dead, 'command': command})
        return result

    def inventory(self):
        nodes = self.request('nodes')['nodes']
        try:
            panes = self.panes()
        except ControlError:
            panes = {}
        for node in nodes:
            name = 'nt-' + re.sub(r'[^a-zA-Z0-9_-]', '_', node['id'])
            matches = panes.get(name, []) if node.get('kind') == 'terminal' else []
            node['controlAvailable'] = len(matches) == 1 and matches[0]['paneDead'] == '0'
            if node['controlAvailable']:
                node['pane'] = matches[0]
        return nodes

    def screen(self, pane):
        return self.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', pane)

    def pin(self, node_id):
        nodes = [node for node in self.inventory() if node['id'] == node_id]
        if len(nodes) != 1 or not nodes[0]['controlAvailable']:
            raise ControlError('The selected node has no unique, live local terminal pane.')
        node = nodes[0]
        pane = node['pane']
        socket_path = self.tmux('display-message', '-p', '-t', pane['paneId'], '#{socket_path}').strip()
        socket_info = os.stat(socket_path)
        screen = self.screen(pane['paneId'])
        target = {'version': 1, 'url': self.url, 'socket': self.socket,
                  'serverStartedAt': self.request('health')['startedAt'],
                  'socketInode': socket_info.st_ino, 'socketDevice': socket_info.st_dev,
                  'nodeId': node['id'], 'projectId': node['projectId'], 'title': node['title'],
                  'pane': pane, 'screenSha256': hashlib.sha256(screen.encode()).hexdigest()}
        return target, screen, node

    def validate(self, saved, check_screen=False, allow_busy=False):
        if saved.get('version') != 1 or saved.get('url') != self.url or saved.get('socket') != self.socket:
            raise ControlError('Target belongs to a different server or CLI format.')
        current, screen, node = self.pin(saved['nodeId'])
        for key in ('serverStartedAt', 'socketInode', 'socketDevice', 'projectId'):
            if current[key] != saved.get(key):
                raise ControlError('Stale target: server or node identity changed. Inspect and pin it again.')
        for key in ('sessionName', 'sessionCreated', 'paneId', 'panePid'):
            if current['pane'][key] != saved.get('pane', {}).get(key):
                raise ControlError('Stale target: terminal session changed. Inspect and pin it again.')
        if check_screen and current['screenSha256'] != saved.get('screenSha256'):
            raise ControlError('Terminal screen changed after inspection. Inspect and pin it again; nothing was sent.')
        if check_screen and not allow_busy and node.get('agentStatus') in ('working', 'blocked'):
            raise ControlError('Agent is busy or blocked. Use its conversation interface, or --allow-busy for an intentional input.')
        return current, screen

    def send(self, target, body, enter, allow_busy):
        if not body or len(body) > 1024 * 1024:
            raise ControlError('Input must contain 1 through 1,048,576 UTF-8 bytes.')
        body = body.decode('utf-8-sig').encode('utf-8')
        if any(byte < 32 and byte not in (9, 10, 13) for byte in body) or b'\x7f' in body:
            raise ControlError('Terminal control bytes are not accepted as text.')
        current, unused = self.validate(target, check_screen=True, allow_busy=allow_busy)
        pane = current['pane']['paneId']
        if not re.fullmatch(r'%[0-9]+', pane):
            raise ControlError('Invalid pane identity.')
        buffer = 'nt-paste-fern-' + uuid.uuid4().hex
        # Same stdin/private-buffer/bracketed-paste delivery used by NodeTerm's tmux-naming.ts.
        # Paste and Enter are one command list: a failed paste never submits a prior human draft.
        argv = ['load-buffer', '-b', buffer, '-', ';',
                'if-shell', '-F', '-t', pane, '#{pane_in_mode}', 'send-keys -t %s -X cancel' % pane, ';',
                'paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', pane]
        if enter:
            argv.extend([';', 'send-keys', '-t', pane, 'Enter'])
        try:
            self.tmux(*argv, input_bytes=body)
        finally:
            # Failure before paste may leave our private buffer. Never touch numbered human buffers.
            subprocess.run(['tmux', '-L', self.socket, 'delete-buffer', '-b', buffer],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        return {'nodeId': current['nodeId'], 'paneId': pane, 'bytesDelivered': len(body),
                'enterSent': enter, 'executionVerified': False}


def save_target(path, target):
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(dest.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x') as stream:
            os.chmod(temp, 0o600)
            json.dump(target, stream, indent=2)
        temp.replace(dest)
    finally:
        if temp.exists():
            temp.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8443')
    parser.add_argument('--socket', default='node-terminal')
    parser.add_argument('--data-dir', default=str(Path.home() / '.nodeterm-server'))
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('nodes')
    commands.add_parser('health')
    pin = commands.add_parser('pin', help='Inspect a node and save a non-secret, generation-pinned target.')
    pin.add_argument('--node-id', required=True)
    pin.add_argument('--output', required=True)
    capture = commands.add_parser('capture')
    capture.add_argument('--target-file', required=True)
    send = commands.add_parser('send', help='Text from stdin or a file. Read the pinned preview before sending.')
    send.add_argument('--target-file', required=True)
    send.add_argument('--body-file')
    send.add_argument('--enter', action='store_true')
    send.add_argument('--allow-busy', action='store_true')
    spawn = commands.add_parser('spawn', help='Create a visible operator-owned plain shell node.')
    spawn.add_argument('--project-id', required=True)
    spawn.add_argument('--title', required=True)
    spawn.add_argument('--cwd', default='/tmp')
    spawn.add_argument('--task-id', required=True, help='Stable declared task ID; never inferred from title or model.')
    spawn.add_argument('--task-planning-file', help='UTF-8 JSON planning: explicit category, urgency evidence and independent/support parent intent.')
    spawn.add_argument('--owner', required=True, help='Descriptive owner; organization requires all three metadata flags.')
    spawn.add_argument('--workstream', required=True, help='Exact independent workstream label (1 to 80 ASCII characters).')
    spawn.add_argument('--functional-role', required=True, help='Explicit exact role; no title or model classification.')
    spawn.add_argument('--idempotency-key', required=True, help='Stable caller-provided logical creation key, required for organization.')
    receipt = commands.add_parser('receipt', help='Read one creation receipt; never creates or repeats a launch.')
    receipt.add_argument('--idempotency-key', required=True)
    commands.add_parser('cleanup-preview', help='Read current archive witnesses; no task disposition is inferred.')
    cleanup = commands.add_parser('cleanup', aliases=['archive'], help='Routine cleanup: recoverable archive of one exact reviewed cohort.')
    cleanup.add_argument('--request-file', required=True, help='Bounded current reviewed-preview packet with explicit task dispositions.')
    cleanup.add_argument('--receipt-file', required=True, help='New absolute local outcome/undo receipt file; never overwrites.')
    cleanup_receipt_parser = commands.add_parser('cleanup-receipt', help='Read one archive/undo receipt without a mutation.')
    cleanup_receipt_parser.add_argument('--receipt-id', required=True)
    commands.add_parser('cleanup-receipts', help='List recovery receipt IDs; never retries a mutation.')
    cleanup_undo = commands.add_parser('cleanup-undo', aliases=['undo'], help='Clear only the exact receipt archive markers; preserve later edits.')
    cleanup_undo.add_argument('--receipt-id', required=True)
    cleanup_undo.add_argument('--receipt-file', required=True, help='New absolute local undo outcome file; never overwrites.')
    close = commands.add_parser('close', help='Permanently remove a dead operator-created card/history/bindings; routine cleanup uses archive.')
    close.add_argument('--target-file', required=True)
    args = parser.parse_args()
    if args.command == 'spawn':
        spawn_args = {'project_id': args.project_id, 'title': args.title, 'cwd': args.cwd,
                      'owner': args.owner, 'workstream': args.workstream,
                      'functional_role': args.functional_role, 'idempotency_key': args.idempotency_key, 'task_id': args.task_id}
        if args.task_planning_file:
            planning_bytes = Path(args.task_planning_file).read_bytes()
            if len(planning_bytes) > 16384:
                raise ControlError('Task planning exceeds the 16 KiB input budget.')
            spawn_args['task_planning'] = json.loads(planning_bytes.decode('utf-8-sig'))
        spawn_body(**spawn_args)  # Reject incomplete/bad metadata before authentication or network I/O.
    elif args.command == 'receipt':
        validate_creation_key(args.idempotency_key)
    elif args.command in ('cleanup', 'archive'):
        cleanup_request = read_cleanup_request(args.request_file)
    elif args.command in ('cleanup-receipt', 'cleanup-undo', 'undo'):
        if not cleanup_uuid(args.receipt_id):
            raise ControlError('An exact cleanup receipt UUID is required.')
    client = NodeTerm(args)
    if args.command == 'nodes':
        emit({'nodes': client.inventory()})
    elif args.command == 'health':
        emit(client.request('health'))
    elif args.command == 'pin':
        target, screen, unused = client.pin(args.node_id)
        save_target(args.output, target)
        emit({'targetFile': args.output, 'target': target, 'screen': screen})
    elif args.command in ('capture', 'send', 'close'):
        saved = json.loads(Path(args.target_file).read_text())
        if args.command == 'capture':
            current, screen = client.validate(saved)
            emit({'target': current, 'screen': screen})
        elif args.command == 'send':
            body = Path(args.body_file).read_bytes() if args.body_file else sys.stdin.buffer.read(1048577)
            emit(client.send(saved, body, args.enter, args.allow_busy))
        else:
            # Closing only applies to a card this operator created, after its shell has exited.
            if saved.get('url') != client.url or saved.get('serverStartedAt') != client.request('health')['startedAt']:
                raise ControlError('Stale server target; nothing was closed.')
            matches = [row for row in client.request('nodes')['nodes'] if row['id'] == saved['nodeId']]
            if len(matches) != 1 or not matches[0].get('operatorCreated') or matches[0]['paneState'] != 'dead':
                raise ControlError('Close requires an operator-created node with a confirmed dead pane.')
            emit(client.request('nodes/' + urllib.parse.quote(saved['nodeId'], safe=''), 'DELETE'))
    elif args.command == 'spawn':
        emit(client.spawn(**spawn_args))
    elif args.command == 'receipt':
        emit(client.receipt(args.idempotency_key))
    elif args.command == 'cleanup-preview':
        emit(client.cleanup_preview())
    elif args.command in ('cleanup', 'archive'):
        emit(client.cleanup(cleanup_request, args.receipt_file))
    elif args.command == 'cleanup-receipt':
        emit(client.cleanup_receipt(args.receipt_id))
    elif args.command == 'cleanup-receipts':
        emit(client.cleanup_receipts())
    elif args.command in ('cleanup-undo', 'undo'):
        emit(client.cleanup_undo(args.receipt_id, args.receipt_file))


if __name__ == '__main__':
    try:
        if os.name == 'nt':
            # Native Windows callers keep the configured Ubuntu route and Linux-only credentials.
            arguments = sys.argv[1:]
            body = sys.stdin.buffer.read(1048577) if windows_stdin_required(arguments) else b''
            result = run_windows(arguments, body)
            sys.stdout.buffer.write(result.stdout)
            sys.stderr.buffer.write(result.stderr)
            sys.exit(result.returncode)
        main()
    except (ControlError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        details = error.details if isinstance(error, (CreationUncertain, CleanupUncertain)) else {'error': str(error)}
        print(json.dumps(details, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
