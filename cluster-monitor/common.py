"""主节点中台和副节点 agent 共用的小工具：令牌检查、只读 JSON 接口。

接口规则：
- 只允许 GET；其他方法（包括 HEAD、OPTIONS）一律 405。
- 每个请求都要带 Authorization: Bearer <令牌>，不对才 401。
- 不设 CORS 头，浏览器不能跨站读取。
- 不记访问日志（里面会有客户端地址）。
- 路由出错只回 500 并在标准错误里打一行类型名，不打请求内容。
"""
import hmac
import json
import sys
from http.server import BaseHTTPRequestHandler

MIN_TOKEN_LENGTH = 24
BEARER = 'Bearer '
REQUEST_TIMEOUT_SECONDS = 10


def require_token(token, name):
    """令牌没设、太短、或者全是空白就拒绝启动，免得裸奔。返回去掉首尾空白的令牌。"""
    token = (token or '').strip()
    if len(token) < MIN_TOKEN_LENGTH:
        raise SystemExit(f'{name} 没设置或太短（至少 {MIN_TOKEN_LENGTH} 个字符）')
    return token


def split_list(text):
    return [item.strip() for item in (text or '').split(',') if item.strip()]


def authorized(header_value, token):
    if not token or not header_value or not header_value.startswith(BEARER):
        return False
    given = header_value[len(BEARER):].encode('utf-8')
    return hmac.compare_digest(given, token.encode('utf-8'))


def make_handler(routes, token):
    """routes 是 {路径: 无参函数}，函数返回 (状态码, 数据)。没有写在表里的路径一律 404。"""

    class Handler(BaseHTTPRequestHandler):
        server_version = 'cluster-monitor'
        sys_version = ''
        timeout = REQUEST_TIMEOUT_SECONDS  # 慢连接或只发一半的请求，到时间就断开

        def log_message(self, fmt, *args):
            return

        def send_json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            route = routes.get(self.path.split('?', 1)[0])
            if route is None:
                return self.send_json(404, {'error': 'not_found'})
            if not authorized(self.headers.get('Authorization'), token):
                return self.send_json(401, {'error': 'unauthorized'})
            try:
                status, payload = route()
            except Exception as error:  # 出错只回一个固定的 500，不把细节和请求内容带出去
                print(f'[cluster] 路由出错：{type(error).__name__}', file=sys.stderr)
                return self.send_json(500, {'error': 'internal'})
            return self.send_json(status, payload)

        def reject_method(self):
            self.send_json(405, {'error': 'method_not_allowed'})

        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = reject_method

    return Handler
