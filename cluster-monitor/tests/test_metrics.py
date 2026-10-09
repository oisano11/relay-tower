import errno
import http.client
import os
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import metrics  # noqa: E402


def completed(returncode=0, stdout='', stderr=''):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def write_file(test, text):
    handle, path = tempfile.mkstemp()
    with os.fdopen(handle, 'w') as f:
        f.write(text)
    test.addCleanup(os.remove, path)
    return path


class FakeCpu:
    def __init__(self, value):
        self.value = value

    def percent(self):
        return self.value


class FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    """假的 urllib 打开器：fn 返回回应，或者抛出异常。"""

    def __init__(self, fn):
        self.fn = fn

    def open(self, url, timeout=None):
        return self.fn(url, timeout)


def fake_connect(error):
    """假的连接函数：每次都抛出给定的异常，不发任何包。"""
    def connect(address, timeout=None, source_address=None):
        raise error
    return connect


class CpuTests(unittest.TestCase):
    def test_totals_are_idle_and_all_ticks(self):
        path = write_file(self, 'cpu  100 0 50 800 20 0 0 0 0 0\ncpu0 1 1 1 1\n')
        self.assertEqual(metrics.read_cpu_totals(path), (820, 970))

    def test_first_sample_has_no_percent_then_the_change_does(self):
        samples = iter([(820, 970), (900, 1070)])
        sampler = metrics.CpuSampler(read=lambda: next(samples))
        self.assertIsNone(sampler.percent())
        self.assertEqual(sampler.percent(), 20.0)  # 100 个滴答里 80 个空闲，忙 20%

    def test_unreadable_cpu_is_none_not_a_guess(self):
        def boom():
            raise OSError('no /proc')
        self.assertIsNone(metrics.CpuSampler(read=boom).percent())


class MemoryTests(unittest.TestCase):
    def test_percent_comes_from_total_and_available(self):
        path = write_file(self, 'MemTotal:       4194304 kB\nMemAvailable:   2097152 kB\n')
        self.assertEqual(metrics.read_memory(path), {'totalMb': 4096, 'usedMb': 2048, 'percent': 50.0})

    def test_missing_field_is_none(self):
        path = write_file(self, 'MemTotal:       4194304 kB\n')
        self.assertIsNone(metrics.safe(metrics.read_memory)(path))


class DiskTests(unittest.TestCase):
    def test_reads_a_real_directory(self):
        result = metrics.read_disk(tempfile.gettempdir())
        self.assertEqual(set(result), {'totalGb', 'usedGb', 'percent'})
        self.assertTrue(0 <= result['percent'] <= 100)


class ContainerTests(unittest.TestCase):
    def test_expected_names_get_their_state_and_missing_ones_say_so(self):
        def run(*args, **kwargs):
            return completed(stdout='sub2api\trunning\nsub2api-redis\texited\n')
        self.assertEqual(metrics.read_containers(['sub2api', 'sub2api-postgres', 'sub2api-redis'], run=run), [
            {'name': 'sub2api', 'state': 'running'},
            {'name': 'sub2api-postgres', 'state': 'missing'},
            {'name': 'sub2api-redis', 'state': 'exited'},
        ])

    def test_docker_failure_is_none(self):
        def run(*args, **kwargs):
            return completed(returncode=1)
        self.assertIsNone(metrics.safe(metrics.read_containers)(['sub2api'], run=run))

    def test_docker_not_installed_is_none(self):
        def run(*args, **kwargs):
            raise FileNotFoundError('docker')
        self.assertIsNone(metrics.safe(metrics.read_containers)(['sub2api'], run=run))

    def test_nothing_expected_skips_docker(self):
        def run(*args, **kwargs):
            raise AssertionError('docker should not run')
        self.assertEqual(metrics.read_containers([], run=run), [])


class CustomerRequestTests(unittest.TestCase):
    def test_only_customer_calls_are_counted_and_each_request_once(self):
        # 真实日志里一条请求的 path 字段出现两次；控制台的管理接口（/api/v1）不算客户请求
        log = '\n'.join([
            'x http request completed\t{"path": "/v1/chat/completions", "method": "POST", "path": "/v1/chat/completions"}',
            'x http request completed\t{"path": "/api/v1/auth/me", "method": "GET", "path": "/api/v1/auth/me"}',
            'x http request completed\t{"path": "/v1/messages", "path": "/v1/messages"}',
            'noise line without any request',
        ])

        def run(*args, **kwargs):
            return completed(stdout=log)
        self.assertEqual(metrics.count_requests('sub2api', run=run), 2)

    def test_failure_is_none(self):
        def run(*args, **kwargs):
            return completed(returncode=1)
        self.assertIsNone(metrics.safe(metrics.count_requests)('sub2api', run=run))

    def test_only_the_end_of_the_log_is_read(self):
        # 只带 --since 会从头扫整份日志（线上 700 多 MB 要 17 秒），必须带 --tail
        seen = {}

        def run(args, **kwargs):
            seen['args'] = args
            return completed(stdout='')
        metrics.count_requests('sub2api', run=run)
        self.assertEqual(seen['args'], ['docker', 'logs', '--tail', str(metrics.REQUEST_TAIL_LINES), '--since', '60s', 'sub2api'])

    def test_a_window_with_more_lines_than_the_tail_is_unknown_not_a_partial_count(self):
        def run(*args, **kwargs):
            return completed(stdout='\n'.join(['{"path": "/v1/chat/completions"}'] * 3))
        self.assertIsNone(metrics.safe(metrics.count_requests)('sub2api', run=run, tail=3))
        self.assertEqual(metrics.count_requests('sub2api', run=run, tail=4), 3)

    def test_lines_on_both_output_streams_are_counted(self):
        def run(*args, **kwargs):
            return completed(stdout='{"path": "/v1/messages"}', stderr='{"path": "/v1/chat/completions"}\n')
        self.assertEqual(metrics.count_requests('sub2api', run=run), 2)


class ProbeTcpTests(unittest.TestCase):
    def test_a_listening_port_is_up(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            server.listen(1)
            port = server.getsockname()[1]
            result = metrics.probe_tcp('127.0.0.1', port, timeout=2)
        self.assertIs(result['ok'], True)
        self.assertIsNotNone(result['rttMs'])

    def test_a_refused_connection_means_the_peer_answered_so_the_link_is_up(self):
        # 本机一个没人监听的端口：对面回了 RST，说明包已经到了
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        result = metrics.probe_tcp('127.0.0.1', port, timeout=2)
        self.assertIs(result['ok'], True)

    def test_a_timeout_is_down(self):
        result = metrics.probe_tcp('192.0.2.2', 8898, connect=fake_connect(socket.timeout('timed out')))
        self.assertEqual(result, {'ok': False, 'rttMs': None})

    def test_no_route_to_host_is_down(self):
        result = metrics.probe_tcp('192.0.2.2', 8898, connect=fake_connect(OSError(errno.EHOSTUNREACH, 'No route to host')))
        self.assertEqual(result, {'ok': False, 'rttMs': None})

    def test_a_tunnel_address_this_machine_does_not_have_is_down(self):
        # 真实的绑定失败：203.0.113.250 是文档保留地址，本机没有，bind 会直接失败，不会发出任何包
        result = metrics.probe_tcp('127.0.0.1', 9, source_ip='203.0.113.250', timeout=2)
        self.assertIs(result['ok'], False)

    def test_a_name_that_does_not_resolve_is_unknown_not_down(self):
        self.assertIsNone(metrics.probe_tcp('no-such-host.example', 8898, connect=fake_connect(socket.gaierror('no such host'))))

    def test_the_source_address_is_passed_when_given(self):
        seen = {}

        def connect(address, timeout=None, source_address=None):
            seen['source'] = source_address
            raise ConnectionRefusedError()
        metrics.probe_tcp('192.0.2.2', 8898, source_ip='192.0.2.1', connect=connect)
        self.assertEqual(seen['source'], ('192.0.2.1', 0))


class ProbeTests(unittest.TestCase):
    def test_healthy_service_is_true(self):
        self.assertIs(metrics.probe_http('http://probe.invalid/health', opener=FakeOpener(lambda u, t: FakeResponse(200))), True)

    def test_refused_connection_is_false_not_none(self):
        def opener(url, timeout):
            raise urllib.error.URLError('refused')
        self.assertIs(metrics.probe_http('http://probe.invalid/health', opener=FakeOpener(opener)), False)

    def test_a_reply_that_is_not_http_is_false_not_an_exception(self):
        def opener(url, timeout):
            raise http.client.BadStatusLine('garbage')
        self.assertIs(metrics.probe_http('http://probe.invalid/health', opener=FakeOpener(opener)), False)


class NodeFactsTests(unittest.TestCase):
    def failing_sources(self):
        return {
            'memory': lambda: None,
            'disk': lambda path: None,
            'load': lambda: None,
            'containers': lambda expected: None,
            'probe': lambda url: False,
            'requests': lambda container: None,
        }

    def test_unreadable_values_stay_none_and_a_down_service_is_false(self):
        settings = {'sub2api_health_url': 'http://probe.invalid/health', 'request_container': 'sub2api',
                    'expect_containers': ['sub2api']}
        node = metrics.node_facts(settings, FakeCpu(None), 1000, self.failing_sources())
        self.assertTrue(node['reachable'])
        for key in ('cpuPercent', 'memory', 'disk', 'loadAvg', 'containers', 'requests60s'):
            self.assertIsNone(node[key], key)
        self.assertIs(node['sub2apiOk'], False)

    def test_without_a_health_url_or_container_nothing_is_measured(self):
        node = metrics.node_facts({}, FakeCpu(12.5), 1000, self.failing_sources())
        self.assertEqual(node['cpuPercent'], 12.5)
        self.assertIsNone(node['sub2apiOk'])
        self.assertIsNone(node['requests60s'])


if __name__ == '__main__':
    unittest.main()
