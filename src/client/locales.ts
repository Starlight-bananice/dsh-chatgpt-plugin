/**
 * Locale dictionaries for the ChatGPT card.
 *
 * `zh` is the key-set source of truth and `en` is kept complete against it, the
 * convention the other client plugins in this application follow. The namespace
 * string is also what the slot registration passes as `locale`, which is what
 * synthesizes the component's `t` seat.
 *
 * @module dsh-chatgpt-provider/client/locales
 */

/** This card's locale namespace. */
export const NS = 'chatgpt-provider'

const zh = {
  'nav': 'ChatGPT',
  'pageLede': '用你的 ChatGPT 账号登录，即可把 ChatGPT 方案（Plus / Pro）的模型当作一个普通 provider 使用。'
    + '登录凭据保存在 Harness 的凭据文档里；这里也可以切换账号、重新授权、退出登录，或发一个真实的小请求测试连通性。',
  'title': '使用你的 ChatGPT 方案',
  'usingPlan': '正在使用 ChatGPT 方案',
  'intro': '在此应用中完成符合条件的 AI 请求，用量计入你的 ChatGPT 方案或额度余额。',
  'active': '当前',
  'noPlan': '未授予方案用量',
  'use': '使用',
  'reauthorize': '重新授权',
  'signOut': '退出登录',
  'cancel': '取消',
  'continue': '使用 ChatGPT 继续登录',
  'different': '使用其他 ChatGPT 账号',
  'manageUsage': '管理用量',
  'waiting': '等待浏览器完成登录…',
  'exchanging': '正在完成登录…',
  'fallback': '如果没有自动打开窗口，',
  'fallbackLink': '点此继续登录',
  'loading': '正在读取 ChatGPT 登录状态…',
  'noCredentials': '此部署未挂载凭据服务，ChatGPT 登录无处保存。',
  'revokeWarning': '已在本地退出登录，但未能撤销 ChatGPT 会话：',
  'test': '测试连接',
  'testing': '正在发送一个真实请求…',
  'testOk': '连通正常 · ',
  'testFail': '测试失败 · ',
}

const en: Record<keyof typeof zh, string> = {
  'nav': 'ChatGPT',
  'pageLede': 'Sign in with your ChatGPT account to use ChatGPT plan (Plus / Pro) models as an ordinary '
    + 'provider. Credentials are stored in the harness credential document; from here you can also switch '
    + 'accounts, reauthorize, sign out, or send one small real request to check connectivity.',
  'title': 'Use your ChatGPT plan',
  'usingPlan': 'Using ChatGPT plan',
  'intro': 'Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.',
  'active': 'active',
  'noPlan': 'plan usage not granted',
  'use': 'Use',
  'reauthorize': 'Reauthorize',
  'signOut': 'Sign out',
  'cancel': 'Cancel',
  'continue': 'Continue with ChatGPT',
  'different': 'Use a different ChatGPT account',
  'manageUsage': 'Manage usage',
  'waiting': 'Waiting for the browser to finish…',
  'exchanging': 'Finishing the sign-in…',
  'fallback': 'If no window opened, ',
  'fallbackLink': 'continue signing in here',
  'loading': 'Loading ChatGPT sign-in state…',
  'noCredentials': 'This deployment mounts no credential service, so a ChatGPT sign-in has nowhere to be stored.',
  'revokeWarning': 'Signed out locally, but the ChatGPT session could not be revoked: ',
  'test': 'Test',
  'testing': 'Sending one real request…',
  'testOk': 'Working · ',
  'testFail': 'Test failed · ',
}

export { zh, en }
