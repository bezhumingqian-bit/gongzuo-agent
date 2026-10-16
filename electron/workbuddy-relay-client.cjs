// Production desktop transport. WorkBuddy app secrets and provider tokens stay
// in the HTTPS relay; the renderer never receives the relay session credential.
const crypto = require('node:crypto');
const { isIP } = require('node:net');

class RelayClientError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function relayOrigin(value, { allowTestHttp = false } = {}) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new RelayClientError('url', '授权服务地址必须是有效的 HTTPS 域名'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || /[\\\s%]/.test(raw) ||
      (url.protocol !== 'https:' && !(allowTestHttp && local && url.protocol === 'http:')) ||
      (!allowTestHttp && (local || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')))) {
    throw new RelayClientError('url', '授权服务必须使用 HTTPS 域名，不含路径、账号、查询参数；本机测试不用于正式授权');
  }
  return url.origin;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = text => crypto.createHash('sha256').update(text).digest('base64url');
const required = (text, re) => typeof text === 'string' && re.test(text);

async function relayRequest(baseUrl, route, { method = 'GET', sessionToken, body, fetchImpl = fetch, allowTestHttp = false } = {}) {
  const origin = relayOrigin(baseUrl, { allowTestHttp });
  if (!origin) throw new RelayClientError('no-relay', '请先填写部署好的 HTTPS 授权服务地址');
  const allowed = new Set(['/healthz', '/v1/auth/start', '/v1/auth/claim', '/v1/auth/cancel', '/v1/auth/status', '/v1/auth/session', '/v1/localassistant', '/v1/localassistant/message', '/v1/localassistant/release']);
  const target = new URL(route, origin);
  if (target.origin !== origin || !allowed.has(target.pathname)) throw new RelayClientError('route', '不支持的授权服务请求');
  let response;
  try {
    response = await fetchImpl(target.toString(), {
      method, headers: { accept: 'application/json', ...(body != null ? { 'content-type': 'application/json' } : {}), ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
      ...(body != null ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(18000)
    });
  } catch { throw new RelayClientError('network', '无法连接授权服务，请检查部署地址和网络；不会自动重复发送任务'); }
  if (response.status === 204 && response.ok) return { ok: true };
  let data;
  try { data = await response.json(); } catch { throw new RelayClientError('response', '授权服务返回了非预期内容，请检查 HTTPS 代理配置'); }
  if (!response.ok) {
    const messages = {
      invalid_session: '授权已失效，请重新授权', session_expired: '授权已过期，请重新授权', unauthorized: '授权已失效或服务地址已改变，请重新授权', authorization_expired: 'WorkBuddy 授权已失效，请重新授权',
      message_stream_conflict: 'WorkBuddy 期间出现其他消息，无法确定回复归属，请在原客户端核对后结束监听',
      write_recheck_required: '发送状态未确认，请到 WorkBuddy 核对后再结束监听，不能直接重发', write_uncertain: '发送结果未确认，请到 WorkBuddy 核对后结束监听，不能直接重发',
      message_not_owned: '此任务的监听已结束，或属于原设备授权；请回到原设备核对', invalid_attempt: '授权已经过期、取消或领取，请重新发起',
      invalid_claim: '授权校验未通过，请重新发起', attempt_not_found: '授权已过期或已取消，请重新发起',
      account_busy: '这个 WorkBuddy 账号有一项任务仍在监听，请先核对并结束该任务，再发新工作',
      message_interleaved: 'WorkBuddy 期间出现其他消息，不能安全关联回复；请到 WorkBuddy 核对',
      uncertain_delivery: '发送结果未能确认，请先到 WorkBuddy 核对，不能直接重发',
      upstream_unauthorized: 'WorkBuddy 授权已失效，请重新授权',
      upstream_unavailable: 'WorkBuddy 暂时不可用；请核对原任务后再尝试，避免重复执行',
      origin_forbidden: '授权服务拒绝此访问来源', rate_limited: '请求过于频繁，请稍后再试',
      storage_unavailable: '授权服务存储不可用，请联系维护人员'
    };
    const code = typeof data?.error?.code === 'string' ? data.error.code : typeof data?.error === 'string' ? data.error : typeof data?.code === 'string' ? data.code : `http-${response.status}`;
    const error = new RelayClientError(code, messages[code] || `授权服务请求未完成（HTTP ${response.status}），请核对服务配置或原任务`);
    // The uncertainty handle is not a provider message ID; only usable to release
    // the user's own lease after checking the WorkBuddy PC UI.
    const uncertainId = data?.messageId || data?.error?.messageId;
    if (required(uncertainId, /^[A-Za-z0-9_.:-]{1,200}$/)) error.uncertainMessageId = uncertainId;
    throw error;
  }
  return data;
}

class WorkBuddyRelayAuth {
  constructor({ settingsService, openExternal, fetchImpl = fetch, now = Date.now, wait = sleep, allowTestHttp = false, timeoutMs = 5 * 60 * 1000, pollMs = 1200 }) {
    Object.assign(this, { settingsService, openExternal, fetchImpl, now, wait, allowTestHttp, timeoutMs, pollMs });
    this.pending = null;
    this.abortGeneration = 0;
  }
  async origin() { return relayOrigin(await this.settingsService.getWorkbuddyRelayUrl(), { allowTestHttp: this.allowTestHttp }); }
  async record() {
    const base = await this.origin();
    const r = await this.settingsService.readWorkbuddyOAuth();
    return r?.kind === 'relay' && r.relayUrl === base && r.expiresAt > this.now() && required(r.sessionToken, /^[A-Za-z0-9_-]{43,128}$/) ? r : null;
  }
  async status() {
    const [base, old] = await Promise.all([this.origin(), this.settingsService.readWorkbuddyOAuth()]);
    const r = await this.record();
    return { clientConfigured: Boolean(base), clientId: null, clientSource: 'server', authorized: Boolean(r), authorizing: Boolean(this.pending),
      nickname: r?.nickname || null, openId: r?.openId || null, scope: r?.scope || null,
      expiresAt: r ? new Date(r.expiresAt).toISOString() : null, refreshExpiresAt: null,
      redirectUri: base ? `${base}/oauth/callback` : null, relayUrl: base, legacyDetected: Boolean(old && old.kind !== 'relay'),
      capabilities: ['localassistant'], note: '只授权本地助理；不复用云端任务权限，不持有 WorkBuddy 应用密钥。' };
  }
  async authorize({ generation = this.abortGeneration } = {}) {
    // Capture the caller's cancellation generation before the first await.
    if (generation !== this.abortGeneration) throw new RelayClientError('cancelled', '已取消本次授权');
    if (require('./workbuddy-service.cjs').hasLocalAssistantOperations()) throw new RelayClientError('executing', '本地助理正在发送或读取任务，请等待这一轮结束再授权');
    if (this.pending) throw new RelayClientError('busy', '授权已经发起，请在浏览器完成，或先取消');
    const base = await this.origin();
    if (!base) throw new RelayClientError('no-relay', '请先部署 HTTPS 授权服务，并在共作设置中填写地址');
    if (this.pending) throw new RelayClientError('busy', '授权已经发起，请在浏览器完成，或先取消');
    if (generation !== this.abortGeneration) throw new RelayClientError('cancelled', '已取消本次授权');
    const run = (async () => {
      const opts = { fetchImpl: this.fetchImpl, allowTestHttp: this.allowTestHttp };
      let id, verifier;
      try {
        const health = await relayRequest(base, '/healthz', opts);
        if (health.ok !== true || health.redirectUri !== `${base}/oauth/callback`) throw new RelayClientError('health', '授权服务未就绪或回调地址与部署地址不匹配');
        verifier = crypto.randomBytes(48).toString('base64url');
        const start = await relayRequest(base, '/v1/auth/start', { ...opts, method: 'POST', body: { claimChallenge: digest(verifier) } });
        id = start.id;
        if (!required(id, /^[A-Za-z0-9_-]{16,200}$/) || !Number.isFinite(start.expiresAt)) throw new RelayClientError('response', '授权服务返回的授权会话无效');
        const url = new URL(start.authorizeUrl);
        const get = n => url.searchParams.get(n);
        if (url.origin !== 'https://www.workbuddy.cn' || url.pathname !== '/openapi/v2/authorize' || url.username || url.password ||
            get('redirect_uri') !== `${base}/oauth/callback` || get('response_type') !== 'code' || get('code_challenge_method') !== 'S256' || !get('state') || !get('client_id') ||
            !required(get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)) throw new RelayClientError('authorize-url', '授权服务返回了非官方或不匹配的授权地址，已阻止打开');
        const scopes = (get('scope') || '').split(/\s+/).filter(Boolean);
        if (!scopes.includes('user.localassistant.readable') || !scopes.includes('user.localassistant.invokable') || scopes.some(x => !['user.profile.readable','user.localassistant.readable','user.localassistant.invokable'].includes(x))) {
          throw new RelayClientError('scope', '本期只请求个人资料与本地助理的最小权限');
        }
        this.attempt = { base, id, verifier };
        if (generation !== this.abortGeneration) throw new RelayClientError('cancelled', '已取消授权');
        try { await this.openExternal(url.toString()); } catch { throw new RelayClientError('browser', '无法打开授权浏览器，请重新发起'); }
        const until = Math.min(this.now() + this.timeoutMs, start.expiresAt);
        while (this.now() < until) {
          if (generation !== this.abortGeneration) throw new RelayClientError('cancelled', '已取消授权');
          const claim = await relayRequest(base, '/v1/auth/claim', { ...opts, method: 'POST', body: { id, claimVerifier: verifier } });
          if (claim.status === 'failed') throw new RelayClientError('denied', 'WorkBuddy 未完成授权，请确认应用已审核通过且回调与权限已登记');
          if (claim.status === 'ready') {
            if (!required(claim.sessionToken, /^[A-Za-z0-9_-]{43,128}$/) || !Number.isFinite(claim.expiresAt) || claim.expiresAt <= this.now()) throw new RelayClientError('response', '授权服务返回的会话凭据无效');
            const currentOrigin = await this.origin();
            if (generation !== this.abortGeneration || currentOrigin !== base) {
              await relayRequest(base, '/v1/auth/session', { ...opts, method: 'DELETE', sessionToken: claim.sessionToken }).catch(() => {});
              throw new RelayClientError('cancelled', '授权已取消或服务地址已改变，请重新授权');
            }
            const record = { kind: 'relay', relayUrl: base, sessionToken: claim.sessionToken, expiresAt: claim.expiresAt,
              nickname: typeof claim.nickname === 'string' ? claim.nickname.slice(0, 60) : null, openId: typeof claim.openId === 'string' ? claim.openId : null,
              scope: claim.scope || null, authorizedAt: new Date(this.now()).toISOString() };
            try { await this.settingsService.writeWorkbuddyOAuth(record); }
            catch (error) { await relayRequest(base, '/v1/auth/session', { ...opts, method: 'DELETE', sessionToken: claim.sessionToken }).catch(() => {}); throw error; }
            const committedOrigin = await this.origin();
            if (generation !== this.abortGeneration || committedOrigin !== base) {
              await relayRequest(base, '/v1/auth/session', { ...opts, method: 'DELETE', sessionToken: claim.sessionToken }).catch(() => {});
              const saved = await this.settingsService.readWorkbuddyOAuth();
              if (saved?.sessionToken === record.sessionToken) await this.settingsService.writeWorkbuddyOAuth(null);
              throw new RelayClientError('cancelled', '授权已取消或服务地址改变，没有保存新的授权');
            }
            // Do not return sessionToken across IPC to the renderer.
            return { nickname: record.nickname, openId: record.openId };
          }
          if (claim.status !== 'pending') throw new RelayClientError('response', '未知授权状态，请检查授权服务版本');
          await this.wait(this.pollMs);
        }
        throw new RelayClientError('timeout', '5 分钟内没有完成授权，请重新发起');
      } catch (error) {
        if (id && verifier) await relayRequest(base, '/v1/auth/cancel', { ...opts, method: 'POST', body: { id, claimVerifier: verifier } }).catch(() => {});
        throw error;
      } finally { this.attempt = null; }
    })();
    this.pending = run;
    try { return await run; } finally { this.pending = null; }
  }
  async getAccessToken() { return (await this.record())?.sessionToken || null; }
  async cancel() {
    this.abortGeneration++;
    const attempt = this.attempt;
    if (attempt) await relayRequest(attempt.base, '/v1/auth/cancel', { method: 'POST', body: { id: attempt.id, claimVerifier: attempt.verifier }, fetchImpl: this.fetchImpl, allowTestHttp: this.allowTestHttp });
  }
  async signOut() {
    if (require('./workbuddy-service.cjs').hasLocalAssistantOperations()) throw new RelayClientError('executing', '本地助理正在发送或读取任务，请等待这一轮结束再退出授权');
    if (this.pending) { const running = this.pending; await this.cancel(); await running.catch(() => {}); }
    const record = await this.record();
    if (record) await relayRequest(record.relayUrl, '/v1/auth/session', { method: 'DELETE', sessionToken: record.sessionToken, fetchImpl: this.fetchImpl, allowTestHttp: this.allowTestHttp });
    // If a network error prevents remote revocation, keep the credential so the
    // user can retry instead of pretending the server grant was removed.
    await this.settingsService.writeWorkbuddyOAuth(null);
  }
}
module.exports = { WorkBuddyRelayAuth, RelayClientError, relayOrigin, relayRequest };
