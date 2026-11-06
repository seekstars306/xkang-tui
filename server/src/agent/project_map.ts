/**
 * 仓库/端说明：在上下文初始化时放进系统提示（按客服要求补充"每个项目的作用"）。
 *
 * 只写说明性事实——哪个目录是什么端/服务，不写"应该怎么查"。
 * 同一功能在多个端常有各自的实现，这是代码库的结构事实，模型据此自行判断。
 * 业务规则一律现场读代码，不写进提示：写进来会过时，也会变成针对个案的过拟合。
 */
export const PROJECT_MAP_PROMPT = [
  '【代码仓库与端】D:\\skt_project 下各目录对应的端/服务如下，同一功能常在多个端各有一份实现：',
  '- skt-front/skt_dpxt_pc：PC 端页面。',
  '- skt-front/skt-dpxt-h5：H5 端页面（手机浏览器打开的那套）。',
  '- skt-front/skt_dpxt_mobile：移动端页面。',
  '- skt-front/skt_webview、skt-front/skt_new_webview：内嵌 webview 页面（老、新两套并存）。',
  '- skt-front/skt_zfgwjp_mobile：专项移动端页面。',
  '- skt-back、skt-back-new：后端服务，两代实现并存。',
  '- skt-remote：对接外部渠道的微服务（酒店、机票、代理等子仓库）。',
].join('\n');
