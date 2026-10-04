"""Offline caller compatibility tests. Only a disposable loopback HTTP fixture is contacted."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fern_draft', Path(__file__).with_name('fern-nodeterm.py'))
fern = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fern)
CONTRACT = {'version': 1, 'receiptPublication': {'version': 1, 'platform': 'linux', 'guarantee': 'file-and-directory-sync'},
            'assistantCreation': {'version': 1, 'taskId': 'required', 'creationKey': 'exact-required',
            'metadata': 'owner-project-workstream-functionalRole-required', 'privateReceipt': 'before-save-and-spawn',
            'verifiedCreatorSource': True}}
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


if __name__ == '__main__':
    unittest.main()
