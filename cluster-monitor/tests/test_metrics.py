import http.client
import os
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


class RequestTests(unittest.TestCase):
    def test_counts_completed_request_lines_in_both_streams(self):
        def run(*args, **kwargs):
            return completed(stdout='x http request completed 200\nnoise\nhttp request completed 500\n',
                             stderr='http request completed 200\n')
        self.assertEqual(metrics.count_requests('sub2api', run=run), 3)

    def test_failure_is_none(self):
        def run(*args, **kwargs):
            return completed(returncode=1)
        self.assertIsNone(metrics.safe(metrics.count_requests)('sub2api', run=run))


class PingTests(unittest.TestCase):
    def test_reply_gives_round_trip_time(self):
        def run(*args, **kwargs):
            return completed(stdout='64 bytes from 192.0.2.2: icmp_seq=1 ttl=64 time=1.25 ms\n')
        self.assertEqual(metrics.ping_peer('192.0.2.2', run=run), {'ok': True, 'rttMs': 1.25})

    def test_a_reply_in_another_language_still_counts_as_up(self):
        def run(*args, **kwargs):
            return completed(returncode=0, stdout='来自 192.0.2.2 的回复: 字节=64 时间=1ms TTL=64\n')
        self.assertEqual(metrics.ping_peer('192.0.2.2', run=run), {'ok': True, 'rttMs': None})

    def test_no_reply_means_down_not_unknown(self):
        def run(*args, **kwargs):
            return completed(returncode=1)
        self.assertEqual(metrics.ping_peer('192.0.2.2', run=run), {'ok': False, 'rttMs': None})

    def test_ping_itself_failing_means_unknown(self):
        def run(*args, **kwargs):
            return completed(returncode=2)
        self.assertIsNone(metrics.ping_peer('192.0.2.2', run=run))

    def test_ping_not_installed_means_unknown(self):
        def run(*args, **kwargs):
            raise FileNotFoundError('ping')
        self.assertIsNone(metrics.ping_peer('192.0.2.2', run=run))


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
