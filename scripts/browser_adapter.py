"""CDP adapter subprocess; uses the already-open recruiting browser, never launches contacts."""
import json
import selectors
import shutil
import subprocess
from pathlib import Path

from search_flow import SearchError


class BrowserAdapter:
    def __init__(self, port=9222, target=None):
        node = shutil.which('node')
        if not node:
            raise SearchError('未找到Node.js；需要支持内置WebSocket的Node.js 22或以上版本')
        command = [node, str(Path(__file__).with_name('search_browser.mjs')), 'serve', '--port', str(port)]
        if target:
            command += ['--target', target]
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)

    def call(self, **message):
        if self.process.poll() is not None:
            raise SearchError('浏览器连接已退出：' + self.process.stderr.read()[:500])
        try:
            self.process.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
            self.process.stdin.flush()
        except BrokenPipeError:
            raise SearchError('招聘浏览器未连接，请先启动独立调试窗口并完成登录')
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=45):
                self.process.terminate()
                raise SearchError('网页操作超时，已停止；不会自动重试')
        line = self.process.stdout.readline()
        if not line:
            raise SearchError('浏览器连接失败：' + self.process.stderr.read()[:500])
        result = json.loads(line)
        if not result.get('ok'):
            raise SearchError(result.get('error', '网页操作失败'))
        return result.get('result')

    def read(self):
        return self.call(op='read')

    def select_job(self, key):
        return self.call(op='job', key=key)

    def set_filter(self, field, value):
        return self.call(op='filter', field=field, value=value)

    def search(self):
        return self.call(op='search')

    def close(self):
        # Close only this connection process, never browser windows or tabs.
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        for stream in (self.process.stdout, self.process.stderr):
            if stream:
                stream.close()


def preflight(plan, state):
    supported = {'keywords', 'desired_locations', 'experience', 'education'}
    unsupported = (set(plan['filters']) | set(plan['clear'])) - supported
    if unsupported:
        raise SearchError('这些网页字段尚未适配，不能按已填写处理：' + ', '.join(sorted(unsupported)))
    if not plan['filters'].get('keywords'):
        raise SearchError('当前页面需要顾问提供关键词；输入框的提示文字不算已填写')
    for field in ('experience', 'education'):
        if plan['filters'].get(field) == '不限':
            raise SearchError('不限表示清除条件，请放入 clear：' + field)
        if field in plan['filters'] and plan['filters'][field] not in state.get('available', {}).get(field, []):
            raise SearchError('页面不支持此条件值：' + field + '；请使用页面列出的选项')
    cities = plan['filters'].get('desired_locations', [])
    if len(cities) > 10:
        raise SearchError('当前页面最多允许10个期望工作地点')
