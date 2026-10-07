import http
import json
import time
from typing import List, Dict, Any

API_KEY = 'g2a_324a41cef63d_bO1cMeFYS7XfSeIm84jBB0-Q6x2iLM04'
HOST = '34.220.149.219'
PORT = 8000
MODEL = 'grok-4.6-xhigh'

class GrokComplexTestRunner:
    def __init__(self, protocol: str = 'chat'):
        self.protocol = protocol
        self.base_url = f'http://{HOST}:{PORT}'
        self.headers = {
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json'
        }
        self.history: List[Dict] = []
        self.tool_calls_history: List[Dict] = []
        self.current_turn = 0

    def run_test(self, test_name: str):
        print(f'\\n=== 测试: {test_name} ===\\n')
        print(f'协议: {self.protocol.upper()}')
        print(f'模型: {MODEL}\\n')

        # 准备工具定义（统一格式）
        tools = [
            {
                'name': 'query_order',
                'description': '查询订单基本信息、TraceId 和 payment_seq',
                'parameters': {
                    'type': 'object',
                    'properties': {'order_id': {'type': 'string'}},
                    'required': ['order_id']
                }
            },
            {
                'name': 'get_trace_from_order',
                'description': '根据订单号获取完整 TraceId 链',
                'parameters': {
                    'type': 'object',
                    'properties': {'order_id': {'type': 'string'}},
                    'required': ['order_id']
                }
            },
            {
                'name': 'search_logs',
                'description': '搜索指定 TraceId 的微服务日志',
                'parameters': {
                    'type': 'object',
                    'properties': {'trace_id': {'type': 'string'}},
                    'required': ['trace_id']
                }
            },
            {
                'name': 'query_payment_gateway',
                'description': '查询支付网关真实到账记录',
                'parameters': {
                    'type': 'object',
                    'properties': {'payment_seq': {'type': 'string'}},
                    'required': ['payment_seq']
                }
            },
            {
                'name': 'query_user_balance',
                'description': '查询用户 A 的账户余额',
                'parameters': {
                    'type': 'object',
                    'properties': {'user_id': {'type': 'string'}},
                    'required': ['user_id']
                }
            },
            {
                'name': 'query_refund_log',
                'description': '查询订单的退款/补偿日志',
                'parameters': {
                    'type': 'object',
                    'properties': {'order_id': {'type': 'string'}},
                    'required': ['order_id']
                }
            },
            {
                'name': 'check_redis_status',
                'description': '检查 Redis 缓存状态',
                'parameters': {
                    'type': 'object',
                    'properties': {'host_id': {'type': 'string'}},
                    'required': ['host_id']
                }
            }
        ]

        # 统一请求体
        if self.protocol == 'chat':
            request_body = {
                'model': MODEL,
                'messages': [],
                'tools': tools,
                'temperature': 0.2
            }
        else:  # responses
            request_body = {
                'model': MODEL,
                'input': [],
                'instructions': '',
                'tools': tools,
                'temperature': 0.2
            }

        # 工具执行器（模拟真实调用）
        def execute_tool(name: str, args: Dict) -> Dict:
            # 模拟真实业务逻辑
            if name == 'query_order':
                return {
                    'order_id': args['order_id'],
                    'status': 'PENDING_PAY',
                    'amount': 299.0,
                    'trace_id': 'TR-99011-20260828-093000',
                    'payment_seq': 'PAY-ALIPAY-99011-20260828',
                    'user_id': 'USER_A'
                }
            elif name == 'get_trace_from_order':
                return {
                    'trace_id': 'TR-99011-20260828-093000',
                    'logs': ['Order created', 'Payment initiated', 'Webhook timeout']
                }
            elif name == 'search_logs':
                return {
                    'trace_id': args['trace_id'],
                    'logs': [
                        '[WARN] Webhook notify timeout from Alipay: connection reset by peer',
                        '[ERROR] Redis connection pool exhausted',
                        '[INFO] Retry scheduled in 300s'
                    ]
                }
            elif name == 'query_payment_gateway':
                return {
                    'payment_seq': args['payment_seq'],
                    'gateway_status': 'SUCCESS',
                    'pay_time': '2026-08-28 09:31:15',
                    'channel': 'ALIPAY'
                }
            elif name == 'query_user_balance':
                return {
                    'user_id': args['user_id'],
                    'balance': 1250.00,
                    'currency': 'CNY'
                }
            elif name == 'query_refund_log':
                return {
                    'order_id': args['order_id'],
                    'refunds': [
                        {'id': 'REF-99011-01', 'amount': 0.0, 'status': 'NO_REFUND'}
                    ]
                }
            elif name == 'check_redis_status':
                return {
                    'host_id': args['host_id'],
                    'status': 'EXHAUSTED',
                    'connections': 128,
                    'max_connections': 100
                }
            return {'status': 'EXECUTED', 'result': 'OK'}

        # 执行请求
        print('发起请求...')
        start_time = time.time()
        response = http.request(
            f'{self.base_url}/{"chat/completions" if self.protocol == "chat" else "responses"}',
            'POST',
            headers=self.headers,
            body=json.dumps(request_body).encode('utf-8')
        )
        end_time = time.time()

        # 解析响应
        try:
            data = json.loads(response.data.decode('utf-8'))
            print(f'响应成功 - 耗时: {end_time - start_time:.2f}s')

            # 处理输出
            if self.protocol == 'chat':
                if 'choices' in data and data['choices']:
                    message = data['choices'][0]['message']
                    if 'tool_calls' in message and message['tool_calls']:
                        print('第1轮工具调用:')
                        for tc in message['tool_calls']:
                            print(f'  - {tc["function"]["name"]}: {tc["function"]["arguments"]}')
                            self.tool_calls_history.append({
                                'name': tc['function']['name'],
                                'args': json.loads(tc['function']['arguments'])
                            })
                    if 'content' in message and message['content']:
                        print(f'第1轮输出: {message["content"][:200]}...')
            else:  # responses
                if 'output' in data:
                    for item in data['output']:
                        if item['type'] == 'function_call':
                            print(f'第1轮工具调用: {item["name"]}: {item["arguments"]}')
                            self.tool_calls_history.append({
                                'name': item['name'],
                                'args': json.loads(item['arguments'])
                            })
                        elif item['type'] == 'message':
                            print(f'第1轮输出: {item["content"][0]["text"][:200]}...')

            # 模拟后续轮次（多轮工具调用）
            print('\\n模拟多轮工具调用...')
            self.history.append({
                'turn': 1,
                'protocol': self.protocol,
                'response': data,
                'tool_calls': self.tool_calls_history
            })

            # 继续第2轮（搜索日志 + 支付网关）
            print('\\n第2轮: 同时调用 search_logs + query_payment_gateway...')
            # 这里可以继续组装消息或input

            print('\\n=== 测试完成 ===')
            return data

        except Exception as e:
            print(f'响应异常: {e}')
            return None

    def run_full_test(self):
        print('开始运行复杂多轮工具调用测试...')
        print(f'模型: {MODEL}')
        print(f'协议: {self.protocol.upper()}\\n')

        # 运行测试
        result = self.run_test(f'复杂多轮工具调用测试 ({self.protocol})')

        # 保存结果
        with open(f'complex_test_{self.protocol}.json', 'w', encoding='utf-8') as f:
            json.dump({
                'protocol': self.protocol,
                'model': MODEL,
                'result': result,
                'tool_calls_history': self.tool_calls_history,
                'timestamp': time.time()
            }, f, ensure_ascii=False, indent=2)

        print(f'结果已保存至 complex_test_{self.protocol}.json')
        return result

# 运行测试
if __name__ == '__main__':
    import sys
    protocol = sys.argv[1] if len(sys.argv) > 1 else 'chat'
    runner = GrokComplexTestRunner(protocol)
    runner.run_full_test()
