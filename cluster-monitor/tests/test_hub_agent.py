import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import agent  # noqa: E402
import common  # noqa: E402
import hub  # noqa: E402

TOKEN = 'test-token-' + 'x' * 20  # 测试用的假令牌，长度够 24
WORKER_TOKEN = 'worker-token-' + 'y' * 20


def fake_master_sources():
    return {
        'memory': lambda: {'totalMb': 4096, 'usedMb': 2048, 'percent': 50.0},
        'disk': lambda path: {'totalGb': 60.0, 'usedGb': 20.0, 'percent': 33.3},
        'load': lambda: [0.1, 0.2, 0.3],
        'containers': lambda expected: [{'name': name, 'state': 'running'} for name in expected],
        'probe': lambda url: True,
        'requests': lambda container: 7,
    }


def hub_env(**extra):
    env = {'HUB_TOKEN': TOKEN, 'MASTER_LABEL': '主节点测试', 'MASTER_SUB2API_HEALTH_URL': 'http://probe.invalid/h',
           'MASTER_REQUEST_CONTAINER': 'sub2api', 'MASTER_EXPECT_CONTAINERS': 'sub2api,sub2api-redis'}
    env.update(extra)
    return env


class FakeResponse:
    def __init__(self, body, status=200):
        self._body = body
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    def __init__(self, fn):
        self.fn = fn

    def open(self, request, timeout=None):
        return self.fn(request, timeout)


class SettingsTests(unittest.TestCase):
    def test_hub_refuses_to_start_without_a_long_token(self):
        with self.assertRaises(SystemExit):
            hub.load_settings({})
        with self.assertRaises(SystemExit):
            hub.load_settings({'HUB_TOKEN': 'short'})

    def test_a_token_made_of_spaces_is_refused(self):
        with self.assertRaises(SystemExit):
            hub.load_settings({'HUB_TOKEN': ' ' * 40})

    def test_a_token_with_stray_spaces_is_trimmed_on_both_sides(self):
        self.assertEqual(hub.load_settings({'HUB_TOKEN': TOKEN + '   '})['token'], TOKEN)
        self.assertEqual(agent.load_settings({'AGENT_TOKEN': '  ' + WORKER_TOKEN + ' '})['token'], WORKER_TOKEN)

    def test_hub_listens_on_loopback_by_default_even_if_bind_is_blank(self):
        settings = hub.load_settings({'HUB_TOKEN': TOKEN, 'HUB_BIND': '   '})
        self.assertEqual(settings['bind'], '127.0.0.1')
        self.assertEqual(settings['port'], 8899)
        self.assertEqual(settings['interval'], 10)

    def test_worker_url_needs_a_scheme_and_its_own_token(self):
        with self.assertRaises(SystemExit):
            hub.load_settings(hub_env(WORKER_AGENT_URL='192.0.2.2:8898', WORKER_AGENT_TOKEN=WORKER_TOKEN))
        with self.assertRaises(SystemExit):
            hub.load_settings(hub_env(WORKER_AGENT_URL='http://192.0.2.2:8898'))

    def test_agent_refuses_to_start_without_a_token(self):
        with self.assertRaises(SystemExit):
            agent.load_settings({})
        settings = agent.load_settings({'AGENT_TOKEN': WORKER_TOKEN})
        self.assertEqual(settings['bind'], '127.0.0.1')
        self.assertEqual(settings['port'], 8898)
        self.assertEqual(settings['interval'], 5)


class AuthTests(unittest.TestCase):
    def test_only_the_exact_bearer_token_passes(self):
        self.assertTrue(common.authorized('Bearer ' + TOKEN, TOKEN))
        self.assertFalse(common.authorized('Bearer ' + TOKEN + 'x', TOKEN))
        self.assertFalse(common.authorized('Basic ' + TOKEN, TOKEN))
        self.assertFalse(common.authorized(None, TOKEN))

    def test_an_empty_token_never_authorizes(self):
        self.assertFalse(common.authorized('Bearer ', ''))
        self.assertFalse(common.authorized('Bearer  ', ''))


class WorkerFetchTests(unittest.TestCase):
    def test_unconfigured_worker_is_unknown_not_offline(self):
        worker = hub.load_settings(hub_env())['worker']
        node = hub.fetch_worker(worker, 1000)
        self.assertIsNone(node['reachable'])
        self.assertIsNone(node['cpuPercent'])

    def test_unreachable_worker_is_offline_with_no_numbers(self):
        env = hub_env(WORKER_AGENT_URL='http://192.0.2.2:8898', WORKER_AGENT_TOKEN=WORKER_TOKEN, WORKER_LABEL='副节点测试')
        worker = hub.load_settings(env)['worker']

        def opener(request, timeout):
            raise urllib.error.URLError('timed out')
        node = hub.fetch_worker(worker, 1000, opener=FakeOpener(opener))
        self.assertIs(node['reachable'], False)
        self.assertEqual(node['label'], '副节点测试')
        self.assertIn('timed out', node['error'])
        self.assertIsNone(node['memory'])
        self.assertIsNone(node['containers'])

    def test_reachable_worker_sends_the_token_and_keeps_its_numbers(self):
        env = hub_env(WORKER_AGENT_URL='http://192.0.2.2:8898/', WORKER_AGENT_TOKEN=WORKER_TOKEN)
        worker = hub.load_settings(env)['worker']
        seen = {}

        def opener(request, timeout):
            seen['url'] = request.full_url
            seen['auth'] = request.get_header('Authorization')
            body = json.dumps({'node': {'cpuPercent': 4.5, 'memory': None, 'collectedAt': 5}, 'servedAgeMs': 1500}).encode('utf-8')
            return FakeResponse(body)
        node = hub.fetch_worker(worker, 10000, opener=FakeOpener(opener))
        self.assertEqual(seen['url'], 'http://192.0.2.2:8898/snapshot')
        self.assertEqual(seen['auth'], 'Bearer ' + WORKER_TOKEN)
        self.assertIs(node['reachable'], True)
        self.assertEqual(node['cpuPercent'], 4.5)
        self.assertIsNone(node['memory'])
        self.assertEqual(node['collectedAt'], 8500, 'the hub clock, minus how old the reading already was')

    def test_the_worker_clock_does_not_decide_whether_its_data_is_old(self):
        worker = hub.load_settings(hub_env(WORKER_AGENT_URL='http://192.0.2.2:8898', WORKER_AGENT_TOKEN=WORKER_TOKEN))['worker']
        # 副节点的时钟慢了很多（采集时间 1），但它说这份数据只有 2 秒
        body = json.dumps({'node': {'cpuPercent': 1.0, 'collectedAt': 1}, 'servedAgeMs': 2000}).encode('utf-8')
        node = hub.fetch_worker(worker, 50000, opener=FakeOpener(lambda request, timeout: FakeResponse(body)))
        self.assertEqual(node['collectedAt'], 48000)

    def test_a_worker_reply_without_its_age_counts_as_offline(self):
        worker = hub.load_settings(hub_env(WORKER_AGENT_URL='http://192.0.2.2:8898', WORKER_AGENT_TOKEN=WORKER_TOKEN))['worker']
        body = json.dumps({'node': {'cpuPercent': 1.0, 'collectedAt': 1}}).encode('utf-8')
        node = hub.fetch_worker(worker, 50000, opener=FakeOpener(lambda request, timeout: FakeResponse(body)))
        self.assertIs(node['reachable'], False)
        self.assertIn('时间', node['error'])

    def test_garbage_from_worker_counts_as_offline(self):
        worker = hub.load_settings(hub_env(WORKER_AGENT_URL='http://192.0.2.2:8898', WORKER_AGENT_TOKEN=WORKER_TOKEN))['worker']
        node = hub.fetch_worker(worker, 1000, opener=FakeOpener(lambda request, timeout: FakeResponse(b'[]')))
        self.assertIs(node['reachable'], False)

    def test_a_reply_that_is_not_json_counts_as_offline(self):
        worker = hub.load_settings(hub_env(WORKER_AGENT_URL='http://192.0.2.2:8898', WORKER_AGENT_TOKEN=WORKER_TOKEN))['worker']
        node = hub.fetch_worker(worker, 1000, opener=FakeOpener(lambda request, timeout: FakeResponse(b'<html>')))
        self.assertIs(node['reachable'], False)


class ServerCase(unittest.TestCase):
    def serve(self, handler):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:%d' % server.server_address[1]


class RedirectTests(ServerCase):
    def test_a_redirecting_worker_is_not_followed_so_the_token_stays_put(self):
        hits = []

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"node": {}}')

            def log_message(self, fmt, *args):
                return

        target = self.serve(Target)

        class Redirector(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', target + '/snapshot')
                self.end_headers()

            def log_message(self, fmt, *args):
                return

        origin = self.serve(Redirector)
        worker = hub.load_settings(hub_env(WORKER_AGENT_URL=origin, WORKER_AGENT_TOKEN=WORKER_TOKEN))['worker']
        node = hub.fetch_worker(worker, 1000)  # 用默认的打开器（不跟跳转）
        self.assertIs(node['reachable'], False)
        self.assertEqual(hits, [], 'the token must not be sent to the redirect target')


class LinkTests(unittest.TestCase):
    def test_no_peer_configured_is_unknown(self):
        link = hub.load_settings(hub_env())['link']
        self.assertIsNone(hub.read_link(link, 1000)['ok'])

    def test_ping_result_passes_through_and_missing_counters_stay_none(self):
        link = hub.load_settings(hub_env(WG_PEER_IP='192.0.2.2'))['link']

        def bad_iface(iface):
            raise OSError('no such interface')
        result = hub.read_link(link, 1000, ping=lambda ip: {'ok': False, 'rttMs': None}, iface_reader=bad_iface)
        self.assertIs(result['ok'], False)
        self.assertIsNone(result['rxBytes'])
        result = hub.read_link(link, 1000, ping=lambda ip: None, iface_reader=bad_iface)
        self.assertIsNone(result['ok'])
        self.assertIsNotNone(result['error'])


def make_collector(master_sources=None, fetch=None, link_reader=None):
    settings = hub.load_settings(hub_env())
    return hub.Collector(
        settings,
        clock=lambda: 1700000000.0,
        master_sources=master_sources or fake_master_sources(),
        fetch=fetch or (lambda worker, now_ms: hub.empty_node(worker['label'], None, '未配置副节点地址', now_ms)),
        link_reader=link_reader or (lambda link, now_ms: {'ok': None, 'rttMs': None, 'collectedAt': now_ms}),
    )


class CollectorTests(unittest.TestCase):

    def test_snapshot_has_both_nodes_and_the_link_and_is_kept_as_latest(self):
        collector = make_collector()
        self.assertIsNone(collector.latest())
        snapshot = collector.collect_once()
        self.assertEqual(snapshot['collectedAt'], 1700000000000)
        self.assertEqual(snapshot['nodes']['master']['label'], '主节点测试')
        self.assertIs(snapshot['nodes']['master']['reachable'], True)
        self.assertEqual(snapshot['nodes']['master']['requests60s'], 7)
        self.assertIsNone(snapshot['nodes']['worker']['reachable'])
        self.assertEqual(collector.latest(), snapshot)

    def test_one_failing_master_reading_does_not_throw_away_the_round(self):
        sources = fake_master_sources()

        def broken_memory():
            raise RuntimeError('unexpected')
        sources['memory'] = broken_memory
        collector = make_collector(master_sources=sources, fetch=lambda worker, now_ms: hub.empty_node('副节点', False, 'refused', now_ms))
        snapshot = collector.collect_once()
        self.assertIs(snapshot['nodes']['worker']['reachable'], False)
        self.assertIs(snapshot['nodes']['master']['reachable'], True)
        self.assertIsNone(snapshot['nodes']['master']['memory'])

    def test_a_failing_link_check_only_affects_the_link(self):
        def broken_link(link, now_ms):
            raise OSError('boom')
        collector = make_collector(link_reader=broken_link)
        snapshot = collector.collect_once()
        self.assertIsNone(snapshot['link']['ok'])
        self.assertIs(snapshot['nodes']['master']['reachable'], True)


class HubHttpTests(ServerCase):
    def setUp(self):
        self.collector = make_collector()
        handler = common.make_handler({'/api/status': hub.status_route(self.collector)}, TOKEN)
        self.base = self.serve(handler)

    def test_no_token_or_wrong_token_is_refused(self):
        self.assertEqual(call(self.base)[0], 401)
        self.assertEqual(call(self.base, token='wrong-' + TOKEN)[0], 401)

    def test_before_the_first_collection_it_says_not_ready(self):
        status, _, body = call(self.base, token=TOKEN)
        self.assertEqual((status, body), (503, {'error': 'not_ready'}))

    def test_after_collection_the_snapshot_is_served_without_cors(self):
        self.collector.collect_once()
        status, headers, body = call(self.base, token=TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(body['nodes']['master']['label'], '主节点测试')
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(headers.get('Cache-Control'), 'no-store')

    def test_only_get_is_allowed(self):
        self.collector.collect_once()
        for method in ('POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE'):
            self.assertEqual(call(self.base, method=method, token=TOKEN)[0], 405, method)

    def test_no_pages_and_no_path_tricks(self):
        self.collector.collect_once()
        for path in ('/', '/index.html', '/static/../api/status', '/api/status/../status', '/api/status/'):
            self.assertEqual(call(self.base, path=path, token=TOKEN)[0], 404, path)

    def test_a_route_that_raises_gives_a_plain_500_not_a_crash(self):
        def broken():
            raise RuntimeError('secret detail that must not leak')
        handler = common.make_handler({'/api/status': broken}, TOKEN)
        base = self.serve(handler)
        status, _, body = call(base, token=TOKEN)
        self.assertEqual((status, body), (500, {'error': 'internal'}))


class AgentTests(ServerCase):
    def make_source(self, sources=None):
        settings = agent.load_settings({'AGENT_TOKEN': WORKER_TOKEN, 'AGENT_SUB2API_HEALTH_URL': 'http://probe.invalid/h'})
        return agent.SnapshotSource(settings, clock=lambda: 1700000000.0, sources=sources or {
            'memory': lambda: None,
            'disk': lambda path: None,
            'load': lambda: [1.0, 1.0, 1.0],
            'containers': lambda expected: None,
            'probe': lambda url: True,
            'requests': lambda container: None,
        })

    def test_snapshot_needs_the_token_and_returns_the_last_collected_node(self):
        source = self.make_source()
        base = self.serve(common.make_handler({'/snapshot': agent.snapshot_route(source)}, WORKER_TOKEN))
        self.assertEqual(call(base, path='/snapshot')[0], 401)
        self.assertEqual(call(base, path='/snapshot', token=WORKER_TOKEN)[0], 503, 'nothing collected yet')
        source.collect_once()
        status, headers, body = call(base, path='/snapshot', token=WORKER_TOKEN)
        self.assertEqual(status, 200)
        self.assertIs(body['node']['sub2apiOk'], True)
        self.assertIn('servedAgeMs', body)
        self.assertIsNone(body['node']['memory'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(call(base, path='/snapshot', method='POST', token=WORKER_TOKEN)[0], 405)

    def test_requests_do_not_run_the_checks_themselves(self):
        calls = {'n': 0}

        def counting_probe(url):
            calls['n'] += 1
            return True
        source = self.make_source({
            'memory': lambda: None, 'disk': lambda path: None, 'load': lambda: None,
            'containers': lambda expected: None, 'probe': counting_probe, 'requests': lambda c: None,
        })
        source.collect_once()
        base = self.serve(common.make_handler({'/snapshot': agent.snapshot_route(source)}, WORKER_TOKEN))
        for _ in range(3):
            call(base, path='/snapshot', token=WORKER_TOKEN)
        self.assertEqual(calls['n'], 1, 'the health check runs once per collection, not once per request')


def call(base, path='/api/status', method='GET', token=None):
    headers = {}
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token
    data = b'{}' if method == 'POST' else None
    request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as resp:
            return resp.status, dict(resp.headers), json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as error:
        with error:
            body = error.read().decode('utf-8') or '{}'
            try:
                return error.code, dict(error.headers), json.loads(body)
            except ValueError:
                return error.code, dict(error.headers), {}


if __name__ == '__main__':
    unittest.main()
