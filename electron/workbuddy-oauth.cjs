// WorkBuddy Open Platform authorization (OAuth 2.1 authorization code).
// https://open.workbuddy.cn/docs/openapi「认证授权 API」
//
// Flow: open the system browser on /authorize with state + PKCE → the platform
// redirects to a one-shot loopback listener on 127.0.0.1:47321 → exchange the
// code at /token → keep access/refresh tokens encrypted and refresh them before
// they expire.
//
// The client secret is supplied by a "client credentials source". Today that is
// the local one (secret in this Mac's keychain or 共作's encrypted credentials;
// personal testing only). When 共作 gets a server, a broker source replaces it
// and the secret never ships with the desktop app; nothing else here changes.
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');

const API_BASE = 'https://www.workbuddy.cn/openapi/v2';
const CALLBACK_PORT = 47321;
const CALLBACK_PATH = '/oauth/callback';
// Must match, byte for byte, the redirect URI registered on the platform.
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = ['user.profile.readable', 'user.task.invokable', 'user.task.readable', 'user.localassistant.invokable', 'user.localassistant.readable'];
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
const KEYCHAIN = { clientId: 'cn.gongzuo.workbuddy.client-id', clientSecret: 'cn.gongzuo.workbuddy.client-secret' };

class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// The platform redirects back with ?error=… for both a user's "cancel" and its
// own rejections (app not active, scope outside the app's 授权列表, …), so the
// raw code and description are always shown instead of assuming a cancel.
function explainAuthorizeError(error, description) {
  const code = String(error).slice(0, 60);
  const desc = description ? String(description).slice(0, 160) : '';
  const hints = {
    access_denied: '可能是你点了取消，也可能是开放平台应用尚未启用（审核中/未上线）。请到开放平台确认应用状态为「已启用」后重试。',
    invalid_scope: '请求的权限超出应用「授权列表」。请在开放平台给应用勾选：个人资料、本地助理（读/调用）、云端任务（读/调用）后重试。',
    unauthorized_client: '开放平台应用不是启用状态。请确认应用已审核通过并启用。',
    invalid_request: '授权参数被拒绝，请确认开放平台登记的回调地址为 http://127.0.0.1:47321/oauth/callback。'
  };
  const hint = hints[code] || '请把本页地址栏里的完整链接发给助手排查。';
  return {
    code: code === 'access_denied' ? 'denied' : code,
    title: code === 'access_denied' ? '授权被拒绝' : '授权未完成',
    detail: `错误码：${code}${desc ? `（${desc}）` : ''}。${hint}`,
    message: `WorkBuddy 授权页返回 ${code}${desc ? `：${desc}` : ''}。${hint}`
  };
}

const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readKeychain(service) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

// Local source: values saved in 共作 settings win; otherwise the macOS keychain
// items written during developer setup.
function localClientCredentials({ settingsService, keychain = readKeychain } = {}) {
  return {
    kind: 'local',
    async get() {
      const saved = await settingsService?.getWorkbuddyClient?.() || {};
      const clientId = saved.clientId || await keychain(KEYCHAIN.clientId);
      const clientSecret = saved.clientSecret || await keychain(KEYCHAIN.clientSecret);
      return { clientId: clientId || null, clientSecret: clientSecret || null, source: saved.clientId ? 'settings' : clientId ? 'keychain' : null };
    }
  };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// Title/detail may carry platform-supplied text (error_description), so escape.
const CALLBACK_PAGE = (rawTitle, rawDetail) => { const title = escapeHtml(rawTitle); const detail = escapeHtml(rawDetail); return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:-apple-system,sans-serif;background:#f7f8fa;color:#1e3a8a;display:grid;place-items:center;height:100vh;margin:0"><div style="background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#475569;max-width:420px;line-height:1.6">${detail}</p></div>`; };

function tokenError(status, body) {
  const code = body?.error || body?.code || '';
  const detail = body?.error_description || body?.msg || body?.message || '';
  if (code === 'invalid_client' || code === 'unauthorized_client') return new AuthError('invalid-client', `WorkBuddy 不认可这个应用（${code}）：请确认 Client ID/Secret 正确，且应用已审核通过、状态为「已启用」`);
  if (code === 'invalid_grant') return new AuthError('invalid-grant', 'WorkBuddy 授权已失效，请重新授权');
  if (code === 'invalid_scope') return new AuthError('invalid-scope', 'WorkBuddy 拒绝了申请的权限范围：请确认应用授权列表包含 个人资料、云端任务、本地助理 5 项');
  return new AuthError('token-failed', `WorkBuddy 授权失败（HTTP ${status}${code ? ` ${code}` : ''}${detail ? `：${String(detail).slice(0, 120)}` : ''}）`);
}

class WorkBuddyOAuth {
  constructor({ settingsService, clientSource, openExternal, fetchImpl = fetch, now = () => Date.now(), port = CALLBACK_PORT, apiBase = API_BASE }) {
    Object.assign(this, { settingsService, openExternal, fetchImpl, now, port, apiBase });
    this.clientSource = clientSource || localClientCredentials({ settingsService });
    this.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    this.pending = null;
    this.refreshing = null;
  }

  async status() {
    const [token, client] = await Promise.all([this.settingsService.readWorkbuddyOAuth(), this.clientSource.get()]);
    return {
      clientConfigured: Boolean(client.clientId && client.clientSecret),
      clientId: client.clientId ? `${client.clientId.slice(0, 6)}…${client.clientId.slice(-4)}` : null,
      clientSource: client.source,
      authorized: Boolean(token?.refreshToken || (token?.accessToken && token.expiresAt > this.now())),
      authorizing: Boolean(this.pending),
      openId: token?.openId || null,
      nickname: token?.nickname || null,
      scope: token?.scope || null,
      expiresAt: token?.expiresAt ? new Date(token.expiresAt).toISOString() : null,
      refreshExpiresAt: token?.refreshExpiresAt ? new Date(token.refreshExpiresAt).toISOString() : null,
      redirectUri: this.redirectUri
    };
  }

  async postToken(params) {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        redirect: 'error'
      });
    } catch { throw new AuthError('network', '无法连接 WorkBuddy 授权服务，请检查网络'); }
    let body = null;
    try { body = await response.json(); } catch { /* non-JSON error body */ }
    const data = body && typeof body.data === 'object' && body.data && 'code' in body ? body.data : body;
    if (!response.ok || !data?.access_token) throw tokenError(response.status, body);
    return data;
  }

  async saveTokens(data, previous = {}) {
    const now = this.now();
    const record = {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : previous.refreshToken || null,
      // expires_in is documented as seconds; guard against missing/odd values.
      expiresAt: now + Math.max(60, Math.min(Number(data.expires_in) || 3600, 7 * 24 * 3600)) * 1000,
      refreshExpiresAt: data.refresh_token ? now + REFRESH_TOKEN_LIFETIME_MS : previous.refreshExpiresAt || null,
      scope: data.scope ? String(data.scope) : previous.scope || null,
      openId: data.open_id ? String(data.open_id) : previous.openId || null,
      nickname: previous.nickname || null,
      authorizedAt: previous.authorizedAt || new Date(now).toISOString()
    };
    await this.settingsService.writeWorkbuddyOAuth(record);
    return record;
  }

  async fetchProfile(record) {
    try {
      const response = await this.fetchImpl(`${this.apiBase}/user/profile`, { headers: { authorization: `Bearer ${record.accessToken}`, accept: 'application/json' }, redirect: 'error' });
      if (!response.ok) return record;
      const body = await response.json();
      const data = body?.data && typeof body.data === 'object' ? body.data : body;
      const nickname = typeof data?.nickname === 'string' ? data.nickname.slice(0, 60) : null;
      if (!nickname) return record;
      const updated = { ...record, nickname };
      await this.settingsService.writeWorkbuddyOAuth(updated);
      return updated;
    } catch { return record; }
  }

  // Opens the browser and resolves once the loopback callback is handled.
  async authorize() {
    if (this.pending) throw new AuthError('busy', '授权页已打开，请在浏览器中完成授权');
    const client = await this.clientSource.get();
    if (!client.clientId || !client.clientSecret) throw new AuthError('no-client', '还没有配置 WorkBuddy 应用的 Client ID 和 Client Secret');
    const state = base64url(crypto.randomBytes(24));
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const url = new URL(`${this.apiBase}/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: this.redirectUri, scope: SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();

    const run = new Promise((resolve, reject) => {
      let settled = false;
      const server = http.createServer((request, response) => {
        const incoming = new URL(request.url, this.redirectUri);
        if (incoming.pathname !== CALLBACK_PATH) { response.writeHead(404).end(); return; }
        const finish = (ok, title, detail, result) => {
          response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(CALLBACK_PAGE(title, detail));
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          server.close();
          ok ? resolve(result) : reject(result);
        };
        // A forged redirect without our state is ignored instead of ending the wait.
        if (incoming.searchParams.get('state') !== state) {
          response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(CALLBACK_PAGE('授权未完成', '校验信息不匹配，请回到共作重新发起授权。'));
          return;
        }
        const denied = incoming.searchParams.get('error');
        if (denied) {
          const explained = explainAuthorizeError(denied, incoming.searchParams.get('error_description'));
          finish(false, explained.title, explained.detail, new AuthError(explained.code, explained.message));
          return;
        }
        const code = incoming.searchParams.get('code');
        if (!code) { finish(false, '授权未完成', '没有收到授权码，请重试。', new AuthError('no-code', 'WorkBuddy 没有返回授权码')); return; }
        this.postToken({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier })
          .then(data => this.saveTokens(data, {}))
          .then(record => this.fetchProfile(record))
          .then(record => finish(true, '授权完成', '可以关闭此页面，回到共作继续。', record))
          .catch(error => finish(false, '授权失败', String(error.message || '').slice(0, 160), error));
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        server.close();
        reject(new AuthError('timeout', '5 分钟内没有完成授权，请重新发起'));
      }, AUTHORIZE_TIMEOUT_MS);
      server.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error.code === 'EADDRINUSE' ? new AuthError('port-busy', `本机端口 ${this.port} 被占用，无法接收授权结果；请关闭占用它的程序后重试`) : error);
      });
      server.listen(this.port, '127.0.0.1', () => {
        Promise.resolve(this.openExternal(url.toString())).catch(error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          server.close();
          reject(new AuthError('browser', `无法打开浏览器：${error.message}`));
        });
      });
    });
    this.pending = run;
    try { return await run; } finally { this.pending = null; }
  }

  // Valid access token or null. Refreshes ahead of expiry; one refresh at a time.
  async getAccessToken() {
    const record = await this.settingsService.readWorkbuddyOAuth();
    if (!record?.accessToken) return null;
    if (record.expiresAt - this.now() > REFRESH_MARGIN_MS) return record.accessToken;
    if (!record.refreshToken) return record.expiresAt > this.now() ? record.accessToken : null;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const client = await this.clientSource.get();
        if (!client.clientId || !client.clientSecret) throw new AuthError('no-client', '缺少 WorkBuddy 应用凭据，无法续期');
        const data = await this.postToken({ grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: client.clientId, client_secret: client.clientSecret });
        return this.saveTokens(data, record);
      })().finally(() => { this.refreshing = null; });
    }
    try { return (await this.refreshing).accessToken; }
    catch (error) {
      if (error.code === 'invalid-grant') await this.settingsService.writeWorkbuddyOAuth(null);
      // A transient failure keeps a still-valid token usable.
      return record.expiresAt > this.now() ? record.accessToken : null;
    }
  }

  async signOut() { await this.settingsService.writeWorkbuddyOAuth(null); }
}

module.exports = { WorkBuddyOAuth, AuthError, explainAuthorizeError, localClientCredentials, readKeychain, REDIRECT_URI, SCOPES, CALLBACK_PORT, KEYCHAIN };
