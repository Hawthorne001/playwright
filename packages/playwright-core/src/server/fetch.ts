/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import http from 'http';
import https from 'https';
import { Transform, pipeline } from 'stream';
import { TLSSocket } from 'tls';
import * as zlib from 'zlib';

import { assert, constructURLBasedOnBaseURL, createProxyAgent, eventsHelper, monotonicTime  } from '../utils';
import { createGuid } from './utils/crypto';
import { getUserAgent } from './utils/userAgent';
import { BrowserContext, verifyClientCertificates } from './browserContext';
import { Cookie, CookieStore, domainMatches, parseRawCookie } from './cookieStore';
import { MultipartFormData } from './formData';
import { SdkObject } from './instrumentation';
import { isAbortError } from './progress';
import { getMatchingTLSOptionsForOrigin, rewriteOpenSSLErrorIfNeeded } from './socksClientCertificatesInterceptor';
import { httpHappyEyeballsAgent, httpsHappyEyeballsAgent, timingForSocket } from './utils/happyEyeballs';
import { Tracing } from './trace/recorder/tracing';

import type { Playwright } from './playwright';
import type { Progress } from './progress';
import type * as types from './types';
import type { HeadersArray, ProxySettings } from './types';
import type { HTTPCredentials } from '../../types/types';
import type { RegisteredListener } from '../utils';
import type * as channels from '@protocol/channels';
import type * as har from '@trace/har';
import type { LookupAddress } from 'dns';
import type { Readable, TransformCallback } from 'stream';


type FetchRequestOptions = {
  userAgent: string;
  extraHTTPHeaders?: HeadersArray;
  failOnStatusCode?: boolean;
  httpCredentials?: HTTPCredentials;
  proxy?: ProxySettings;
  ignoreHTTPSErrors?: boolean;
  maxRedirects?: number;
  baseURL?: string;
  clientCertificates?: types.BrowserContextOptions['clientCertificates'];
};

type HeadersObject = Readonly<{ [name: string]: string }>;

export type APIRequestEvent = {
  url: URL,
  method: string,
  headers: HeadersObject,
  cookies: channels.NameValue[],
  postData?: Buffer
};

export type APIRequestFinishedEvent = {
  requestEvent: APIRequestEvent,
  httpVersion: string;
  headers: http.IncomingHttpHeaders;
  cookies: channels.NetworkCookie[];
  rawHeaders: string[];
  statusCode: number;
  statusMessage: string;
  body?: Buffer;
  timings: har.Timings;
  serverIPAddress?: string;
  serverPort?: number;
  securityDetails?: har.SecurityDetails;
};

type SendRequestOptions = https.RequestOptions & {
  maxRedirects: number,
  headers: HeadersObject,
  __testHookLookup?: (hostname: string) => LookupAddress[]
};

type SendRequestResult = Omit<channels.APIResponse, 'fetchUid'> & { body: Buffer };

export abstract class APIRequestContext extends SdkObject {
  static Events = {
    Dispose: 'dispose',

    Request: 'request',
    RequestFinished: 'requestfinished',
  };

  readonly fetchResponses: Map<string, Buffer> = new Map();
  readonly fetchLog: Map<string, string[]> = new Map();
  protected static allInstances: Set<APIRequestContext> = new Set();
  _closeReason: string | undefined;

  static findResponseBody(guid: string): Buffer | undefined {
    for (const request of APIRequestContext.allInstances) {
      const body = request.fetchResponses.get(guid);
      if (body)
        return body;
    }
    return undefined;
  }

  constructor(parent: SdkObject) {
    super(parent, 'request-context');
    APIRequestContext.allInstances.add(this);
  }

  protected _disposeImpl() {
    APIRequestContext.allInstances.delete(this);
    this.fetchResponses.clear();
    this.fetchLog.clear();
    this.emit(APIRequestContext.Events.Dispose);
  }

  disposeResponse(fetchUid: string) {
    this.fetchResponses.delete(fetchUid);
    this.fetchLog.delete(fetchUid);
  }

  abstract tracing(): Tracing;

  abstract dispose(options: { reason?: string }): Promise<void>;

  abstract _defaultOptions(): FetchRequestOptions;
  abstract _addCookies(cookies: channels.NetworkCookie[]): Promise<void>;
  abstract _cookies(url: URL): Promise<channels.NetworkCookie[]>;
  abstract storageState(progress: Progress, indexedDB?: boolean): Promise<channels.APIRequestContextStorageStateResult>;

  private _storeResponseBody(body: Buffer): string {
    const uid = createGuid();
    this.fetchResponses.set(uid, body);
    return uid;
  }

  async fetch(progress: Progress, params: channels.APIRequestContextFetchParams): Promise<channels.APIResponse> {
    const defaults = this._defaultOptions();
    const headers: HeadersObject = {
      'user-agent': defaults.userAgent,
      'accept': '*/*',
      'accept-encoding': 'gzip,deflate,br',
    };

    if (defaults.extraHTTPHeaders) {
      for (const { name, value } of defaults.extraHTTPHeaders)
        setHeader(headers, name, value);
    }

    if (params.headers) {
      for (const { name, value } of params.headers)
        setHeader(headers, name, value);
    }

    const requestUrl = new URL(constructURLBasedOnBaseURL(defaults.baseURL, params.url));
    if (params.encodedParams) {
      requestUrl.search = params.encodedParams;
    } else if (params.params) {
      for (const { name, value } of params.params)
        requestUrl.searchParams.append(name, value);
    }

    const credentials = this._getHttpCredentials(requestUrl);
    if (credentials?.send === 'always')
      setBasicAuthorizationHeader(headers, credentials);

    const method = params.method?.toUpperCase() || 'GET';
    const proxy = defaults.proxy;
    let agent;
    // We skip 'per-context' in order to not break existing users. 'per-context' was previously used to
    // workaround an upstream Chromium bug. Can be removed in the future.
    if (proxy?.server !== 'per-context')
      agent = createProxyAgent(proxy, requestUrl);

    let maxRedirects = params.maxRedirects ?? (defaults.maxRedirects ?? 20);
    maxRedirects = maxRedirects === 0 ? -1 : maxRedirects;

    const options: SendRequestOptions = {
      method,
      headers,
      agent,
      maxRedirects,
      ...getMatchingTLSOptionsForOrigin(this._defaultOptions().clientCertificates, requestUrl.origin),
      __testHookLookup: (params as any).__testHookLookup,
    };
    // rejectUnauthorized = undefined is treated as true in Node.js 12.
    if (params.ignoreHTTPSErrors || defaults.ignoreHTTPSErrors)
      options.rejectUnauthorized = false;

    const postData = serializePostData(params, headers);
    if (postData)
      setHeader(headers, 'content-length', String(postData.byteLength));
    const fetchResponse = await this._sendRequestWithRetries(progress, requestUrl, options, postData, params.maxRetries);
    const fetchUid = this._storeResponseBody(fetchResponse.body);
    this.fetchLog.set(fetchUid, progress.metadata.log);
    const failOnStatusCode = params.failOnStatusCode !== undefined ? params.failOnStatusCode : !!defaults.failOnStatusCode;
    if (failOnStatusCode && (fetchResponse.status < 200 || fetchResponse.status >= 400)) {
      let responseText = '';
      if (fetchResponse.body.byteLength) {
        let text = fetchResponse.body.toString('utf8');
        if (text.length > 1000)
          text = text.substring(0, 997) + '...';
        responseText = `\nResponse text:\n${text}`;
      }
      throw new Error(`${fetchResponse.status} ${fetchResponse.statusText}${responseText}`);
    }
    return { ...fetchResponse, fetchUid };
  }

  private _parseSetCookieHeader(responseUrl: string, setCookie: string[] | undefined): channels.NetworkCookie[] {
    if (!setCookie)
      return [];
    const url = new URL(responseUrl);
    // https://datatracker.ietf.org/doc/html/rfc6265#section-5.1.4
    const defaultPath = '/' + url.pathname.substr(1).split('/').slice(0, -1).join('/');
    const cookies: channels.NetworkCookie[] = [];
    for (const header of setCookie) {
      // Decode cookie value?
      const cookie: channels.NetworkCookie | null = parseCookie(header);
      if (!cookie)
        continue;
      // https://datatracker.ietf.org/doc/html/rfc6265#section-5.2.3
      if (!cookie.domain)
        cookie.domain = url.hostname;
      else
        assert(cookie.domain.startsWith('.') || !cookie.domain.includes('.'));
      if (!domainMatches(url.hostname, cookie.domain!))
        continue;
      // https://datatracker.ietf.org/doc/html/rfc6265#section-5.2.4
      if (!cookie.path || !cookie.path.startsWith('/'))
        cookie.path = defaultPath;
      cookies.push(cookie);
    }
    return cookies;
  }

  private async _updateRequestCookieHeader(progress: Progress, url: URL, headers: HeadersObject) {
    if (getHeader(headers, 'cookie') !== undefined)
      return;
    const contextCookies = await progress.race(this._cookies(url));
    // Browser context returns cookies with domain matching both .example.com and
    // example.com. Those without leading dot are only sent when domain is strictly
    // matching example.com, but not for sub.example.com.
    const cookies = contextCookies.filter(c => new Cookie(c).matches(url));
    if (cookies.length) {
      const valueArray = cookies.map(c => `${c.name}=${c.value}`);
      setHeader(headers, 'cookie', valueArray.join('; '));
    }
  }

  private async _sendRequestWithRetries(progress: Progress, url: URL, options: SendRequestOptions, postData?: Buffer, maxRetries?: number): Promise<SendRequestResult>{
    maxRetries ??= 0;
    let backoff = 250;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await this._sendRequest(progress, url, options, postData);
      } catch (e) {
        if (isAbortError(e))
          throw e;
        e = rewriteOpenSSLErrorIfNeeded(e);
        if (maxRetries === 0)
          throw e;
        if (i === maxRetries)
          throw new Error(`Failed after ${i + 1} attempt(s): ${e}`);
        // Retry on connection reset only.
        if (e.code !== 'ECONNRESET')
          throw e;
        progress.log(`  Received ECONNRESET, will retry after ${backoff}ms.`);
        await progress.wait(backoff);
        backoff *= 2;
      }
    }
    throw new Error('Unreachable');
  }

  private async _sendRequest(progress: Progress, url: URL, options: SendRequestOptions, postData?: Buffer): Promise<SendRequestResult>{
    await this._updateRequestCookieHeader(progress, url, options.headers);

    const requestCookies = getHeader(options.headers, 'cookie')?.split(';').map(p => {
      const [name, value] = p.split('=').map(v => v.trim());
      return { name, value };
    }) || [];
    const requestEvent: APIRequestEvent = {
      url,
      method: options.method!,
      headers: options.headers,
      cookies: requestCookies,
      postData
    };
    this.emit(APIRequestContext.Events.Request, requestEvent);

    let destroyRequest: (() => void) | undefined;
    const resultPromise = new Promise<SendRequestResult>((fulfill, reject) => {
      const requestConstructor: ((url: URL, options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => http.ClientRequest)
        = (url.protocol === 'https:' ? https : http).request;
      // If we have a proxy agent already, do not override it.
      const agent = options.agent || (url.protocol === 'https:' ? httpsHappyEyeballsAgent : httpHappyEyeballsAgent);
      const requestOptions = { ...options, agent };

      const startAt = monotonicTime();
      let reusedSocketAt: number | undefined;
      let dnsLookupAt: number | undefined;
      let tcpConnectionAt: number | undefined;
      let tlsHandshakeAt: number | undefined;
      let requestFinishAt: number | undefined;
      let serverIPAddress: string | undefined;
      let serverPort: number | undefined;

      let securityDetails: har.SecurityDetails | undefined;

      const listeners: RegisteredListener[] = [];

      const request = requestConstructor(url, requestOptions as any, async response => {
        const responseAt = monotonicTime();

        const notifyRequestFinished = (body?: Buffer) => {
          const endAt = monotonicTime();
          // spec: http://www.softwareishard.com/blog/har-12-spec/#timings
          const connectEnd = tlsHandshakeAt ?? tcpConnectionAt;
          const timings: har.Timings = {
            send: requestFinishAt! - startAt,
            wait: responseAt - requestFinishAt!,
            receive: endAt - responseAt,
            dns: dnsLookupAt ? dnsLookupAt - startAt : -1,
            connect: connectEnd ? connectEnd - startAt : -1, // "If [ssl] is defined then the time is also included in the connect field "
            ssl: tlsHandshakeAt ? tlsHandshakeAt - tcpConnectionAt! : -1,
            blocked: reusedSocketAt ? reusedSocketAt - startAt : -1,
          };

          const requestFinishedEvent: APIRequestFinishedEvent = {
            requestEvent,
            httpVersion: response.httpVersion,
            statusCode: response.statusCode || 0,
            statusMessage: response.statusMessage || '',
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            cookies,
            body,
            timings,
            serverIPAddress,
            serverPort,
            securityDetails,
          };
          this.emit(APIRequestContext.Events.RequestFinished, requestFinishedEvent);
        };
        progress.log(`← ${response.statusCode} ${response.statusMessage}`);
        for (const [name, value] of Object.entries(response.headers))
          progress.log(`  ${name}: ${value}`);

        const cookies = this._parseSetCookieHeader(response.url || url.toString(), response.headers['set-cookie']) ;
        if (cookies.length) {
          try {
            await this._addCookies(cookies);
          } catch (e) {
            // Cookie value is limited by 4096 characters in the browsers. If setCookies failed,
            // we try setting each cookie individually just in case only some of them are bad.
            await Promise.all(cookies.map(c => this._addCookies([c]).catch(() => {})));
          }
        }

        if (redirectStatus.includes(response.statusCode!) && options.maxRedirects >= 0) {
          if (options.maxRedirects === 0) {
            reject(new Error('Max redirect count exceeded'));
            request.destroy();
            return;
          }
          const headers = { ...options.headers };
          removeHeader(headers, `cookie`);

          // HTTP-redirect fetch step 13 (https://fetch.spec.whatwg.org/#http-redirect-fetch)
          const status = response.statusCode!;
          let method = options.method!;
          if ((status === 301 || status === 302) && method === 'POST' ||
              status === 303 && !['GET', 'HEAD'].includes(method)) {
            method = 'GET';
            postData = undefined;
            removeHeader(headers, `content-encoding`);
            removeHeader(headers, `content-language`);
            removeHeader(headers, `content-length`);
            removeHeader(headers, `content-location`);
            removeHeader(headers, `content-type`);
          }


          const redirectOptions: SendRequestOptions = {
            method,
            headers,
            agent: options.agent,
            maxRedirects: options.maxRedirects - 1,
            ...getMatchingTLSOptionsForOrigin(this._defaultOptions().clientCertificates, url.origin),
            __testHookLookup: options.__testHookLookup,
          };
          // rejectUnauthorized = undefined is treated as true in node 12.
          if (options.rejectUnauthorized === false)
            redirectOptions.rejectUnauthorized = false;

          // HTTP-redirect fetch step 4: If locationURL is null, then return response.
          // Best-effort UTF-8 decoding, per spec it's US-ASCII only, but browsers are more lenient.
          // Node.js parses it as Latin1 via std::v8::String, so we convert it to UTF-8.
          const locationHeaderValue = Buffer.from(response.headers.location ?? '', 'latin1').toString('utf8');
          if (locationHeaderValue) {
            let locationURL;
            try {
              locationURL = new URL(locationHeaderValue, url);
            } catch (error) {
              reject(new Error(`uri requested responds with an invalid redirect URL: ${locationHeaderValue}`));
              request.destroy();
              return;
            }

            if (headers['host'])
              headers['host'] = locationURL.host;

            notifyRequestFinished();
            fulfill(this._sendRequest(progress, locationURL, redirectOptions, postData));
            request.destroy();
            return;
          }
        }
        if (response.statusCode === 401 && !getHeader(options.headers, 'authorization')) {
          const auth = response.headers['www-authenticate'];
          const credentials = this._getHttpCredentials(url);
          if (auth?.trim().startsWith('Basic') && credentials) {
            setBasicAuthorizationHeader(options.headers, credentials);
            notifyRequestFinished();
            fulfill(this._sendRequest(progress, url, options, postData));
            request.destroy();
            return;
          }
        }
        response.on('aborted', () => reject(new Error('aborted')));

        const chunks: Buffer[] = [];
        const notifyBodyFinished = () => {
          const body = Buffer.concat(chunks);
          notifyRequestFinished(body);
          fulfill({
            url: response.url || url.toString(),
            status: response.statusCode || 0,
            statusText: response.statusMessage || '',
            headers: toHeadersArray(response.rawHeaders),
            body
          });
        };

        let body: Readable = response;
        let transform: Transform | undefined;
        const encoding = response.headers['content-encoding'];
        if (encoding === 'gzip' || encoding === 'x-gzip') {
          transform = zlib.createGunzip({
            flush: zlib.constants.Z_SYNC_FLUSH,
            finishFlush: zlib.constants.Z_SYNC_FLUSH
          });
        } else if (encoding === 'br') {
          transform = zlib.createBrotliDecompress({
            flush: zlib.constants.BROTLI_OPERATION_FLUSH,
            finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
          });
        } else if (encoding === 'deflate') {
          transform = zlib.createInflate();
        }
        if (transform) {
          // Brotli and deflate decompressors throw if the input stream is empty.
          const emptyStreamTransform = new SafeEmptyStreamTransform(notifyBodyFinished);
          body = pipeline(response, emptyStreamTransform, transform, e => {
            if (e)
              reject(new Error(`failed to decompress '${encoding}' encoding: ${e.message}`));
          });
          body.on('error', e => reject(new Error(`failed to decompress '${encoding}' encoding: ${e}`)));
        } else {
          body.on('error', reject);
        }

        body.on('data', chunk => chunks.push(chunk));
        body.on('end', notifyBodyFinished);
      });
      request.on('error', reject);
      destroyRequest = () => request.destroy();

      listeners.push(
          eventsHelper.addEventListener(this, APIRequestContext.Events.Dispose, () => {
            reject(new Error('Request context disposed.'));
            request.destroy();
          })
      );
      request.on('close', () => eventsHelper.removeEventListeners(listeners));

      request.on('socket', socket => {
        if (request.reusedSocket) {
          reusedSocketAt = monotonicTime();
          return;
        }

        // happy eyeballs don't emit lookup and connect events, so we use our custom ones
        const happyEyeBallsTimings = timingForSocket(socket);
        dnsLookupAt = happyEyeBallsTimings.dnsLookupAt;
        tcpConnectionAt = happyEyeBallsTimings.tcpConnectionAt;

        // non-happy-eyeballs sockets
        listeners.push(
            eventsHelper.addEventListener(socket, 'lookup', () => { dnsLookupAt = monotonicTime(); }),
            eventsHelper.addEventListener(socket, 'connect', () => { tcpConnectionAt = monotonicTime(); }),
            eventsHelper.addEventListener(socket, 'secureConnect', () => {
              tlsHandshakeAt = monotonicTime();

              if (socket instanceof TLSSocket) {
                const peerCertificate = socket.getPeerCertificate();
                securityDetails = {
                  protocol: socket.getProtocol() ?? undefined,
                  subjectName: peerCertificate.subject.CN,
                  validFrom: new Date(peerCertificate.valid_from).getTime() / 1000,
                  validTo: new Date(peerCertificate.valid_to).getTime() / 1000,
                  issuer: peerCertificate.issuer.CN
                };
              }
            }),
        );

        serverIPAddress = socket.remoteAddress;
        serverPort = socket.remotePort;
      });
      request.on('finish', () => { requestFinishAt = monotonicTime(); });

      progress.log(`→ ${options.method} ${url.toString()}`);
      if (options.headers) {
        for (const [name, value] of Object.entries(options.headers))
          progress.log(`  ${name}: ${value}`);
      }

      if (postData)
        request.write(postData);
      request.end();
    });

    return progress.race(resultPromise).catch(error => {
      destroyRequest?.();
      throw error;
    });
  }

  private _getHttpCredentials(url: URL) {
    if (!this._defaultOptions().httpCredentials?.origin || url.origin.toLowerCase() === this._defaultOptions().httpCredentials?.origin?.toLowerCase())
      return this._defaultOptions().httpCredentials;
    return undefined;
  }
}

class SafeEmptyStreamTransform extends Transform {
  private _receivedSomeData: boolean = false;
  private _onEmptyStreamCallback: () => void;

  constructor(onEmptyStreamCallback: () => void) {
    super();
    this._onEmptyStreamCallback = onEmptyStreamCallback;
  }
  override _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    this._receivedSomeData = true;
    callback(null, chunk);
  }
  override _flush(callback: TransformCallback): void {
    if (this._receivedSomeData)
      callback(null);
    else
      this._onEmptyStreamCallback();
  }
}

export class BrowserContextAPIRequestContext extends APIRequestContext {
  private readonly _context: BrowserContext;

  constructor(context: BrowserContext) {
    super(context);
    this._context = context;
    context.once(BrowserContext.Events.Close, () => this._disposeImpl());
  }

  override tracing() {
    return this._context.tracing;
  }

  override async dispose(options: { reason?: string }) {
    this._closeReason = options.reason;
    this.fetchResponses.clear();
  }

  _defaultOptions(): FetchRequestOptions {
    return {
      userAgent: this._context._options.userAgent || this._context._browser.userAgent(),
      extraHTTPHeaders: this._context._options.extraHTTPHeaders,
      failOnStatusCode: undefined,
      httpCredentials: this._context._options.httpCredentials,
      proxy: this._context._options.proxy || this._context._browser.options.proxy,
      ignoreHTTPSErrors: this._context._options.ignoreHTTPSErrors,
      baseURL: this._context._options.baseURL,
      clientCertificates: this._context._options.clientCertificates,
    };
  }

  async _addCookies(cookies: channels.NetworkCookie[]): Promise<void> {
    await this._context.addCookies(cookies);
  }

  async _cookies(url: URL): Promise<channels.NetworkCookie[]> {
    return await this._context.cookies(url.toString());
  }

  override async storageState(progress: Progress, indexedDB?: boolean): Promise<channels.APIRequestContextStorageStateResult> {
    return this._context.storageState(progress, indexedDB);
  }
}


export class GlobalAPIRequestContext extends APIRequestContext {
  private readonly _cookieStore: CookieStore = new CookieStore();
  private readonly _options: FetchRequestOptions;
  private readonly _origins: channels.OriginStorage[] | undefined;
  private readonly _tracing: Tracing;

  constructor(playwright: Playwright, options: channels.PlaywrightNewRequestOptions) {
    super(playwright);
    this.attribution.context = this;
    if (options.storageState) {
      this._origins = options.storageState.origins?.map(origin => ({ indexedDB: [], ...origin }));
      this._cookieStore.addCookies(options.storageState.cookies || []);
    }
    verifyClientCertificates(options.clientCertificates);
    this._options = {
      baseURL: options.baseURL,
      userAgent: options.userAgent || getUserAgent(),
      extraHTTPHeaders: options.extraHTTPHeaders,
      failOnStatusCode: !!options.failOnStatusCode,
      ignoreHTTPSErrors: !!options.ignoreHTTPSErrors,
      maxRedirects: options.maxRedirects,
      httpCredentials: options.httpCredentials,
      clientCertificates: options.clientCertificates,
      proxy: options.proxy,
    };
    this._tracing = new Tracing(this, options.tracesDir);
  }

  override tracing() {
    return this._tracing;
  }

  override async dispose(options: { reason?: string }) {
    this._closeReason = options.reason;
    await this._tracing.flush();
    await this._tracing.deleteTmpTracesDir();
    this._disposeImpl();
  }

  _defaultOptions(): FetchRequestOptions {
    return this._options;
  }

  async _addCookies(cookies: channels.NetworkCookie[]): Promise<void> {
    this._cookieStore.addCookies(cookies);
  }

  async _cookies(url: URL): Promise<channels.NetworkCookie[]> {
    return this._cookieStore.cookies(url);
  }

  override async storageState(progress: Progress, indexedDB = false): Promise<channels.APIRequestContextStorageStateResult> {
    return {
      cookies: this._cookieStore.allCookies(),
      origins: (this._origins || []).map(origin => ({ ...origin, indexedDB: indexedDB ? origin.indexedDB : [] })),
    };
  }
}

function toHeadersArray(rawHeaders: string[]): types.HeadersArray {
  const result: types.HeadersArray = [];
  for (let i = 0; i < rawHeaders.length; i += 2)
    result.push({ name: rawHeaders[i], value: rawHeaders[i + 1] });
  return result;
}

const redirectStatus = [301, 302, 303, 307, 308];

function parseCookie(header: string): channels.NetworkCookie | null {
  const raw = parseRawCookie(header);
  if (!raw)
    return null;
  const cookie: channels.NetworkCookie = {
    domain: '',
    path: '',
    expires: -1,
    httpOnly: false,
    secure: false,
    // From https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite
    // The cookie-sending behavior if SameSite is not specified is SameSite=Lax.
    sameSite: 'Lax',
    ...raw
  };
  return cookie;
}

function serializePostData(params: channels.APIRequestContextFetchParams, headers: HeadersObject): Buffer | undefined {
  assert((params.postData ? 1 : 0) + (params.jsonData ? 1 : 0) + (params.formData ? 1 : 0) + (params.multipartData ? 1 : 0) <= 1, `Only one of 'data', 'form' or 'multipart' can be specified`);
  if (params.jsonData !== undefined) {
    setHeader(headers, 'content-type', 'application/json', true);
    return Buffer.from(params.jsonData, 'utf8');
  } else if (params.formData) {
    const searchParams = new URLSearchParams();
    for (const { name, value } of params.formData)
      searchParams.append(name, value);
    setHeader(headers, 'content-type', 'application/x-www-form-urlencoded', true);
    return Buffer.from(searchParams.toString(), 'utf8');
  } else if (params.multipartData) {
    const formData = new MultipartFormData();
    for (const field of params.multipartData) {
      if (field.file)
        formData.addFileField(field.name, field.file);
      else if (field.value)
        formData.addField(field.name, field.value);
    }
    setHeader(headers, 'content-type', formData.contentTypeHeader(), true);
    return formData.finish();
  } else if (params.postData !== undefined) {
    setHeader(headers, 'content-type', 'application/octet-stream', true);
    return params.postData;
  }
  return undefined;
}

function setHeader(headers: { [name: string]: string }, name: string, value: string, keepExisting = false) {
  const existing = Object.entries(headers).find(pair => pair[0].toLowerCase() === name.toLowerCase());
  if (!existing)
    headers[name] = value;
  else if (!keepExisting)
    headers[existing[0]] = value;
}

function getHeader(headers: HeadersObject, name: string) {
  const existing = Object.entries(headers).find(pair => pair[0].toLowerCase() === name.toLowerCase());
  return existing ? existing[1] : undefined;
}

function removeHeader(headers: { [name: string]: string }, name: string) {
  delete headers[name];
}

function setBasicAuthorizationHeader(headers: { [name: string]: string }, credentials: HTTPCredentials) {
  const { username, password } = credentials;
  const encoded = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  setHeader(headers, 'authorization', `Basic ${encoded}`);
}
