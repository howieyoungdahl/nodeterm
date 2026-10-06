"""Offline caller compatibility tests. Only a disposable loopback HTTP fixture is contacted."""
import importlib.util
import copy
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fern_draft', Path(__file__).with_name('fern-nodeterm.py'))
fern = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fern)
CONTRACT = {'version': 1, 'receiptPublication': {'version': 1, 'platform': 'linux', 'guarantee': 'file-and-directory-sync'},
            'assistantCreation': {'version': 1, 'taskId': 'required', 'creationKey': 'exact-required',
            'metadata': 'owner-project-workstream-functionalRole-required', 'privateReceipt': 'before-save-and-spawn',
            'verifiedCreatorSource': True,
            'taskPlanning': 'category-urgency-reason-relationship-before-save-and-spawn'}}
ARGS = {'project_id': 'fixture-project', 'title': 'Explicit caller title', 'owner': 'Declared Fern',
        'workstream': 'fixture', 'functional_role': 'review', 'idempotency_key': 'stable-creation', 'task_id': 'stable-task'}


class CallerCompatibility(unittest.TestCase):
    def setUp(self):
        self.calls = []; self.contract = CONTRACT; self.contract_status = 200; self.post_status = 200
        self.receipt_status = 200
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *unused):
                pass

            def respond(self, status, body):
                self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_GET(self):
                fixture.calls.append(('GET', self.path, None))
                fixture.assertEqual(self.headers['Authorization'], 'Bearer synthetic-fixture-only')
                if self.path == '/opsapi/creation-contract':
                    self.respond(fixture.contract_status, fixture.contract)
                else:
                    fixture.assertEqual(self.path, '/opsapi/creation-receipts/stable-creation')
                    self.respond(fixture.receipt_status, {'idempotencyKey': 'stable-creation', 'id': 'child',
                        'projectId': 'fixture-project', 'stage': 'finished', 'outcome': 'success'})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fixture.calls.append(('POST', self.path, body))
                fixture.assertEqual(self.path, '/opsapi/nodes')
                self.respond(fixture.post_status, {'idempotencyKey': 'stable-creation', 'id': 'child',
                                                   'projectId': 'fixture-project'})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.client = fern.NodeTerm.__new__(fern.NodeTerm)
        self.client.url = 'http://127.0.0.1:%s' % self.server.server_port
        self.client.token = 'synthetic-fixture-only'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_rejects_missing_local_task_fields_before_any_get_or_post(self):
        for field in ('task_id', 'idempotency_key', 'owner', 'workstream', 'functional_role'):
            with self.subTest(field=field), self.assertRaises(fern.ControlError):
                self.client.spawn(**{**ARGS, field: None})
        self.assertEqual(self.calls, [])

    def test_rejects_old_unavailable_or_weaker_contract_without_post_or_receipt_probe(self):
        for status, body in [(404, {}), (200, {'version': 1}), (200, {'version': 2}),
                             (200, {**CONTRACT, 'assistantCreation': {**CONTRACT['assistantCreation'], 'privateReceipt': 'optional'}}),
                             (200, {**CONTRACT, 'version': True}),
                             (200, {**CONTRACT, 'assistantCreation': {**CONTRACT['assistantCreation'], 'verifiedCreatorSource': 1}}),
                             (200, {k: v for k, v in CONTRACT.items() if k != 'receiptPublication'}),
                             (200, {**CONTRACT, 'receiptPublication': {'version': 1, 'platform': 'win32', 'guarantee': 'file-and-directory-sync'}}),
                             (200, {**CONTRACT, 'receiptPublication': {'version': True, 'platform': 'linux', 'guarantee': 'file-and-directory-sync'}})]:
            self.calls.clear(); self.contract_status = status; self.contract = body
            with self.subTest(status=status, body=body), self.assertRaises(fern.ControlError):
                self.client.spawn(**ARGS)
            self.assertEqual([(method, route) for method, route, _ in self.calls], [('GET', '/opsapi/creation-contract')])

    def test_matching_contract_keeps_exact_task_key_owner_and_complete_metadata(self):
        self.assertEqual(self.client.spawn(**ARGS)['id'], 'child')
        self.assertEqual([(m, r) for m, r, _ in self.calls], [('GET', '/opsapi/creation-contract'), ('POST', '/opsapi/nodes')])
        body = self.calls[1][2]
        self.assertEqual(body['creation'], {'version': 1, 'taskId': 'stable-task', 'creationId': 'stable-creation', 'declaredOwner': 'Declared Fern'})
        self.assertEqual(body['organization'], {'owner': 'Declared Fern', 'workstream': 'fixture', 'functionalRole': 'review', 'projectId': 'fixture-project'})
        self.assertEqual(body['idempotencyKey'], 'stable-creation')

    def test_explicit_windows_visibility_acknowledgment_preserves_the_same_creation_contract(self):
        self.contract = {**CONTRACT, 'receiptPublication': {'version': 1, 'platform': 'win32', 'guarantee': 'file-flush-visibility'}}
        self.assertEqual(self.client.spawn(**ARGS)['id'], 'child')
        self.assertEqual([(m, r) for m, r, _ in self.calls], [('GET', '/opsapi/creation-contract'), ('POST', '/opsapi/nodes')])

    def test_planning_keeps_exact_category_reason_and_explicit_parent_intent(self):
        planning = {'version': 1, 'taskId': 'stable-task', 'category': 'research',
                    'categoryReason': 'Explicit evidence collection task', 'relationship': 'support',
                    'parentTaskId': 'parent-task-1234',
                    'urgency': {'mode': 'auto', 'level': 'medium', 'reason': 'Routine evidence work', 'signals': []}}
        self.assertEqual(self.client.spawn(**ARGS, task_planning=planning)['id'], 'child')
        self.assertEqual(self.calls[1][2]['creation']['planning'], planning)
        with self.assertRaises(fern.ControlError):
            fern.spawn_body(**ARGS, task_planning={**planning, 'taskId': 'another-task'})

    def test_old_contract_without_planning_guarantee_refuses_before_post(self):
        self.contract = {**CONTRACT, 'assistantCreation': {k: v for k, v in CONTRACT['assistantCreation'].items() if k != 'taskPlanning'}}
        with self.assertRaises(fern.ControlError):
            self.client.spawn(**ARGS)
        self.assertEqual([(m, r) for m, r, _ in self.calls], [('GET', '/opsapi/creation-contract')])

    def test_uncertain_post_reads_one_receipt_and_never_repeats_post_or_claims_success(self):
        for receipt_status in (200, 404):
            self.calls.clear(); self.post_status = 503; self.receipt_status = receipt_status
            with self.subTest(receipt_status=receipt_status), self.assertRaises(fern.CreationUncertain) as result:
                self.client.spawn(**ARGS)
            self.assertFalse(result.exception.details['launchSuccessVerified'])
            self.assertFalse(result.exception.details['requestedContentVerified'])
            self.assertEqual([m for m, _, _ in self.calls], ['GET', 'POST', 'GET'])

    def test_create_timeout_is_35_seconds_and_recovery_get_retains_20_seconds(self):
        actual = self.client.request
        with patch.object(self.client, 'request', wraps=actual) as request:
            self.post_status = 503
            with self.assertRaises(fern.CreationUncertain): self.client.spawn(**ARGS)
            self.assertEqual(request.call_args_list[1].kwargs, {'timeout': 35})
            self.assertEqual(request.call_args_list[2].kwargs, {})
        self.assertEqual(fern.REQUEST_TIMEOUT, 20)


PLAN_ID = '10000000-0000-4000-8000-000000000001'
CLEANUP_ID = '10000000-0000-4000-8000-000000000002'
REVIEW = {'projectId': 'fixture-project', 'entries': [
    {'nodeId': node, 'disposition': 'obsolete-paused', 'ownerDigest': 'c' * 64, 'evidenceDigest': 'd' * 64}
    for node in ('child-a', 'child-b')]}


class CleanupCompatibility(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / 'outcome.json'
        self.calls = []
        self.preview_status = 200
        self.archive_status = 200
        self.preview_transform = lambda value: value
        self.archive_transform = lambda value: value
        self.undo_transform = lambda value: value
        self.receipt = {'version': 1, 'id': CLEANUP_ID, 'planId': PLAN_ID, 'at': int(time.time() * 1000),
            'state': 'applied', 'review': copy.deepcopy(REVIEW['entries']), 'items': [
                {'projectId': REVIEW['projectId'], 'nodeId': e['nodeId'],
                 'generation': 'fixture:' + e['nodeId'], 'before': 'a' * 64, 'after': 'b' * 64}
                for e in REVIEW['entries']]}
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *unused):
                pass

            def respond(self, status, body):
                self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
                try:
                    self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                fixture.calls.append(('GET', self.path, None))
                fixture.assertEqual(self.headers['Authorization'], 'Bearer synthetic-fixture-only')
                if self.path == '/opsapi/cleanup/receipts':
                    self.respond(200, {'version': 1, 'receiptIds': [CLEANUP_ID]})
                elif self.path == '/opsapi/cleanup/receipts/' + CLEANUP_ID:
                    self.respond(200, {'version': 1, 'receipt': fixture.receipt})
                else:
                    fixture.assertEqual(self.path, '/opsapi/cleanup/preview')
                    self.respond(200, fixture.preview())

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fixture.calls.append(('POST', self.path, body))
                fixture.assertEqual(self.headers['Authorization'], 'Bearer synthetic-fixture-only')
                if self.path == '/opsapi/cleanup/reviewed-preview':
                    self.respond(fixture.preview_status, fixture.preview_transform(fixture.preview()))
                elif self.path == '/opsapi/cleanup/archive':
                    self.respond(fixture.archive_status, fixture.archive_transform({'version': 1, 'receipt': copy.deepcopy(fixture.receipt)}))
                else:
                    fixture.assertEqual(self.path, '/opsapi/cleanup/undo')
                    fixture.receipt['state'] = 'undone'
                    self.respond(200, fixture.undo_transform({'version': 1, 'receipt': copy.deepcopy(fixture.receipt)}))

            def do_DELETE(self):
                fixture.calls.append(('DELETE', self.path, None))
                self.respond(500, {'error': 'destructive_route_must_never_be_used'})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.client = fern.NodeTerm.__new__(fern.NodeTerm)
        self.client.url = 'http://127.0.0.1:%s' % self.server.server_port
        self.client.token = 'synthetic-fixture-only'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.temp.cleanup()

    def preview(self):
        now = int(time.time() * 1000)
        return {'version': 1, 'dryRun': True, 'plan': {'id': PLAN_ID, 'mode': 'operator-reviewed',
            'createdAt': now - 1, 'expiresAt': now - 1 + 300_000, 'workspaceHash': 'a' * 64,
            'rows': [{'projectId': REVIEW['projectId'], 'nodeId': e['nodeId'], 'eligible': True,
                'archived': False, 'review': {k: e[k] for k in ('disposition', 'ownerDigest', 'evidenceDigest')},
                'evidence': {'generation': 'fixture:' + e['nodeId']},
                'reviewedFence': {'admissible': True, 'ownerDigest': e['ownerDigest'], 'generation': 'fixture:' + e['nodeId']}}
                for e in REVIEW['entries']]}}

    def routes(self):
        return [(m, r) for m, r, _ in self.calls]

    def test_archive_then_undo_preserves_the_exact_reviewed_cohort_and_durable_receipt(self):
        archived = self.client.cleanup(REVIEW, self.output)
        self.assertEqual(self.routes(), [('POST', '/opsapi/cleanup/reviewed-preview'), ('POST', '/opsapi/cleanup/archive')])
        self.assertEqual(self.calls[0][2], REVIEW)
        self.assertEqual(self.calls[1][2], {'planId': PLAN_ID, 'nodeIds': ['child-a', 'child-b']})
        self.assertTrue(archived['outcomeKnown'])
        self.assertEqual(json.loads(self.output.read_text(encoding='utf-8')), archived)
        before = copy.deepcopy(archived['receipt'])
        undone = self.client.cleanup_undo(CLEANUP_ID, Path(self.temp.name) / 'undo.json')
        self.assertEqual(undone['receipt']['state'], 'undone')
        self.assertEqual(undone['receipt']['items'], before['items'])
        self.assertEqual(undone['receipt']['review'], before['review'])
        self.assertNotIn('synthetic-fixture-only', self.output.read_text(encoding='utf-8'))
        self.assertFalse(any(m == 'DELETE' for m, _, _ in self.calls))

    def test_bad_dispositions_duplicates_force_and_large_packets_fail_before_http(self):
        invalid = [dict(REVIEW, force=True), dict(REVIEW, entries=[]),
                   dict(REVIEW, entries=[REVIEW['entries'][0]] * 2),
                   dict(REVIEW, entries=[dict(REVIEW['entries'][0], disposition='done')]),
                   dict(REVIEW, entries=[dict(REVIEW['entries'][0], disposition=['obsolete-paused'])]),
                   dict(REVIEW, entries=[dict(REVIEW['entries'][0], ownerDigest='invented')]),
                   dict(REVIEW, entries=[dict(REVIEW['entries'][0], nodeId='*')]),
                   dict(REVIEW, entries=REVIEW['entries'] * 51)]
        for packet in invalid:
            with self.subTest(packet=packet), self.assertRaises(fern.ControlError):
                self.client.cleanup(packet, self.output)
        self.assertEqual(self.calls, [])

    def test_existing_output_prevents_posts_without_overwrite(self):
        self.output.write_text('retained prior evidence', encoding='utf-8')
        with self.assertRaises(FileExistsError):
            self.client.cleanup(REVIEW, self.output)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.output.read_text(encoding='utf-8'), 'retained prior evidence')

    def test_changed_expired_or_expanded_preview_never_submits_archive(self):
        def changed(value, kind):
            p = value['plan']
            if kind == 'expired': p['createdAt'] -= 300_000; p['expiresAt'] -= 300_000
            if kind == 'expanded': p['rows'].append(dict(p['rows'][0], nodeId='unapproved'))
            if kind == 'duplicate': p['rows'].append(copy.deepcopy(p['rows'][0]))
            if kind == 'owner': p['rows'][0]['reviewedFence']['ownerDigest'] = 'e' * 64
            if kind == 'generation': p['rows'][0]['evidence']['generation'] = 'replacement'
            if kind == 'project': p['rows'][0]['projectId'] = 'foreign-project'
            if kind == 'mode': p['mode'] = 'automatic'
            return value
        for kind in ('expired', 'expanded', 'duplicate', 'owner', 'generation', 'project', 'mode'):
            self.calls.clear(); self.preview_transform = lambda value: changed(value, kind)
            with self.subTest(kind=kind), self.assertRaises(fern.ControlError):
                self.client.cleanup(REVIEW, Path(self.temp.name) / (kind + '.json'))
            self.assertEqual(self.routes(), [('POST', '/opsapi/cleanup/reviewed-preview')])

    def test_old_server_refuses_without_close_or_sweep_fallback(self):
        self.preview_status = 404
        with self.assertRaises(fern.HTTPControlError):
            self.client.cleanup(REVIEW, self.output)
        self.assertEqual(self.routes(), [('POST', '/opsapi/cleanup/reviewed-preview')])

    def test_archive_authorization_refusal_stops_without_recovery_read(self):
        self.archive_status = 403
        with self.assertRaises(fern.HTTPControlError):
            self.client.cleanup(REVIEW, self.output)
        self.assertEqual([m for m, _, _ in self.calls], ['POST', 'POST'])
        self.assertEqual(json.loads(self.output.read_text(encoding='utf-8'))['phase'], 'refused')

    def test_deeply_nested_error_body_preserves_auth_refusal_and_unknown_outcome_classification(self):
        self.archive_transform = lambda unused: b'[' * 4096 + b']' * 4096
        for status, error in ((403, fern.HTTPControlError), (503, fern.CleanupUncertain)):
            self.calls.clear(); self.archive_status = status
            with self.subTest(status=status), self.assertRaises(error):
                self.client.cleanup(REVIEW, Path(self.temp.name) / ('nested-%s.json' % status))
            self.assertEqual([m for m, _, _ in self.calls], ['POST', 'POST'] + ([] if status == 403 else ['GET']))

    def test_uncertain_archive_reads_once_and_never_replays_or_claims_success(self):
        self.archive_status = 503
        self.archive_transform = lambda unused: {'error': 'cleanup_failed'}
        with self.assertRaises(fern.CleanupUncertain) as result:
            self.client.cleanup(REVIEW, self.output)
        self.assertFalse(result.exception.details['outcomeKnown'])
        self.assertEqual(self.routes(), [('POST', '/opsapi/cleanup/reviewed-preview'), ('POST', '/opsapi/cleanup/archive'),
                                        ('GET', '/opsapi/cleanup/receipts')])
        self.assertEqual(json.loads(self.output.read_text(encoding='utf-8'))['phase'], 'outcome-unknown')

    def test_wrong_cohort_or_plan_ack_stays_unknown_after_one_receipt_read(self):
        def changed(value, kind):
            receipt = value['receipt']
            if kind == 'cohort': receipt['items'][0]['nodeId'] = 'unapproved'
            if kind == 'plan': receipt['planId'] = CLEANUP_ID
            if kind == 'generation': receipt['items'][0]['generation'] = 'replacement'
            if kind == 'state': receipt['state'] = 'prepared'
            return value
        for kind in ('cohort', 'plan', 'generation', 'state'):
            self.calls.clear(); self.archive_transform = lambda value: changed(value, kind)
            with self.subTest(kind=kind), self.assertRaises(fern.CleanupUncertain) as result:
                self.client.cleanup(REVIEW, Path(self.temp.name) / (kind + '.json'))
            self.assertFalse(result.exception.details['outcomeKnown'])
            self.assertEqual([m for m, _, _ in self.calls], ['POST', 'POST', 'GET'])
            self.assertEqual(self.calls[-1][1], '/opsapi/cleanup/receipts/' + CLEANUP_ID)

    def test_oversized_ack_is_bounded_and_reconciled_without_repeating_post(self):
        self.archive_transform = lambda unused: {'version': 1, 'oversized': 'x' * fern.CLEANUP_BYTES}
        with self.assertRaises(fern.CleanupUncertain):
            self.client.cleanup(REVIEW, self.output)
        self.assertEqual([m for m, _, _ in self.calls], ['POST', 'POST', 'GET'])

    def test_disk_error_after_ack_keeps_outcome_unknown_without_replay(self):
        fsync = fern.os.fsync
        calls = []
        def once(fd):
            calls.append(fd)
            if len(calls) == 3: raise OSError('fixture receipt disk failure')
            return fsync(fd)
        with patch.object(fern.os, 'fsync', side_effect=once), self.assertRaises(fern.CleanupUncertain) as result:
            self.client.cleanup(REVIEW, self.output)
        self.assertFalse(result.exception.details['outcomeKnown'])
        self.assertEqual([m for m, _, _ in self.calls], ['POST', 'POST', 'GET'])

    def test_already_undone_and_receipt_inspection_are_read_only(self):
        self.receipt['state'] = 'undone'
        self.assertTrue(self.client.cleanup_undo(CLEANUP_ID, self.output)['outcomeKnown'])
        self.client.cleanup_receipt(CLEANUP_ID)
        self.client.cleanup_receipts()
        self.client.cleanup_preview()
        self.assertTrue(all(m == 'GET' for m, _, _ in self.calls))

    def test_undo_ack_cannot_replace_the_original_cohort_or_receipt(self):
        self.undo_transform = lambda value: {'version': 1, 'receipt': dict(value['receipt'], items=value['receipt']['items'][:1])}
        with self.assertRaises(fern.CleanupUncertain) as result:
            self.client.cleanup_undo(CLEANUP_ID, self.output)
        self.assertFalse(result.exception.details['outcomeKnown'])
        self.assertEqual(self.routes(), [('GET', '/opsapi/cleanup/receipts/' + CLEANUP_ID),
                                        ('POST', '/opsapi/cleanup/undo'), ('GET', '/opsapi/cleanup/receipts/' + CLEANUP_ID)])

    def test_default_cleanup_cli_uses_archive_and_exposes_undo_without_a_delete(self):
        request_file = Path(self.temp.name) / 'review.json'
        request_file.write_text(json.dumps(REVIEW), encoding='utf-8')
        args = ['fern-nodeterm.py', 'cleanup', '--request-file', str(request_file), '--receipt-file', str(self.output)]
        with patch.object(fern.sys, 'argv', args), patch.object(fern, 'NodeTerm', return_value=self.client), redirect_stdout(io.StringIO()):
            fern.main()
        self.assertEqual([m for m, _, _ in self.calls], ['POST', 'POST'])
        self.assertEqual(json.loads(self.output.read_text(encoding='utf-8'))['operation'], 'archive')


if __name__ == '__main__':
    unittest.main()
