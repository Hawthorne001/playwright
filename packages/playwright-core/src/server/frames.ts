/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
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

import { BrowserContext } from './browserContext';
import * as dom from './dom';
import { TimeoutError } from './errors';
import { prepareFilesForUpload } from './fileUploadUtils';
import { FrameSelectors } from './frameSelectors';
import { helper } from './helper';
import { SdkObject, serverSideCallMetadata } from './instrumentation';
import * as js from './javascript';
import * as network from './network';
import { Page } from './page';
import { isAbortError, ProgressController } from './progress';
import * as types from './types';
import { LongStandingScope, asLocator, assert, constructURLBasedOnBaseURL, makeWaitForNextTask, renderTitleForCall } from '../utils';
import { isSessionClosedError } from './protocolError';
import { debugLogger } from './utils/debugLogger';
import { eventsHelper } from './utils/eventsHelper';
import {  isInvalidSelectorError } from '../utils/isomorphic/selectorParser';
import { ManualPromise } from '../utils/isomorphic/manualPromise';
import { compressCallLog } from './callLog';

import type { ConsoleMessage } from './console';
import type { ElementStateWithoutStable, FrameExpectParams, InjectedScript } from '@injected/injectedScript';
import type { Progress } from './progress';
import type { ScreenshotOptions } from './screenshotter';
import type { RegisteredListener } from './utils/eventsHelper';
import type { ParsedSelector } from '../utils/isomorphic/selectorParser';
import type * as channels from '@protocol/channels';

type ContextData = {
  contextPromise: ManualPromise<dom.FrameExecutionContext | { destroyedReason: string }>;
  context: dom.FrameExecutionContext | null;
};

type DocumentInfo = {
  // Unfortunately, we don't have documentId when we find out about
  // a pending navigation from things like frameScheduledNavigaiton.
  documentId: string | undefined,
  request: network.Request | undefined,
};

export type GotoResult = {
  newDocumentId?: string,
};

type ConsoleTagHandler = () => void;

type RegularLifecycleEvent = Exclude<types.LifecycleEvent, 'networkidle'>;

export type FunctionWithSource = (source: { context: BrowserContext, page: Page, frame: Frame}, ...args: any) => any;

export type NavigationEvent = {
  // New frame url after navigation.
  url: string,
  // New frame name after navigation.
  name: string,
  // Information about the new document for cross-document navigations.
  // Undefined for same-document navigations.
  newDocument?: DocumentInfo,
  // Error for cross-document navigations if any. When error is present,
  // the navigation did not commit.
  error?: Error,
  // Whether this event should be visible to the clients via the public APIs.
  isPublic?: boolean;
};

type ElementCallback<T, R> = (injected: InjectedScript, element: Element, data: T) => R;

export class NavigationAbortedError extends Error {
  readonly documentId?: string;
  constructor(documentId: string | undefined, message: string) {
    super(message);
    this.documentId = documentId;
  }
}

type ExpectResult = { matches: boolean, received?: any, log?: string[], timedOut?: boolean };

const kDummyFrameId = '<dummy>';

export class FrameManager {
  private _page: Page;
  private _frames = new Map<string, Frame>();
  private _mainFrame: Frame;
  readonly _consoleMessageTags = new Map<string, ConsoleTagHandler>();
  readonly _signalBarriers = new Set<SignalBarrier>();
  private _webSockets = new Map<string, network.WebSocket>();

  constructor(page: Page) {
    this._page = page;
    this._mainFrame = undefined as any as Frame;
  }

  createDummyMainFrameIfNeeded() {
    if (!this._mainFrame)
      this.frameAttached(kDummyFrameId, null);
  }

  dispose() {
    for (const frame of this._frames.values()) {
      frame._stopNetworkIdleTimer();
      frame._invalidateNonStallingEvaluations('Target crashed');
    }
  }

  mainFrame(): Frame {
    return this._mainFrame;
  }

  frames() {
    const frames: Frame[] = [];
    collect(this._mainFrame);
    return frames;

    function collect(frame: Frame) {
      frames.push(frame);
      for (const subframe of frame.childFrames())
        collect(subframe);
    }
  }

  frame(frameId: string): Frame | null {
    return this._frames.get(frameId) || null;
  }

  frameAttached(frameId: string, parentFrameId: string | null | undefined): Frame {
    const parentFrame = parentFrameId ? this._frames.get(parentFrameId)! : null;
    if (!parentFrame) {
      if (this._mainFrame) {
        // Update frame id to retain frame identity on cross-process navigation.
        this._frames.delete(this._mainFrame._id);
        this._mainFrame._id = frameId;
      } else {
        assert(!this._frames.has(frameId));
        this._mainFrame = new Frame(this._page, frameId, parentFrame);
      }
      this._frames.set(frameId, this._mainFrame);
      return this._mainFrame;
    } else {
      assert(!this._frames.has(frameId));
      const frame = new Frame(this._page, frameId, parentFrame);
      this._frames.set(frameId, frame);
      this._page.emit(Page.Events.FrameAttached, frame);
      return frame;
    }
  }

  async waitForSignalsCreatedBy<T>(progress: Progress, waitAfter: boolean, action: () => Promise<T>): Promise<T> {
    if (!waitAfter)
      return action();
    const barrier = new SignalBarrier(progress);
    this._signalBarriers.add(barrier);
    progress.cleanupWhenAborted(() => this._signalBarriers.delete(barrier));
    const result = await action();
    await progress.race(this._page.delegate.inputActionEpilogue());
    await barrier.waitFor();
    this._signalBarriers.delete(barrier);
    // Resolve in the next task, after all waitForNavigations.
    await new Promise<void>(makeWaitForNextTask());
    return result;
  }

  frameWillPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.retain();
  }

  frameDidPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.release();
  }

  frameRequestedNavigation(frameId: string, documentId?: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    for (const barrier of this._signalBarriers)
      barrier.addFrameNavigation(frame);
    if (frame.pendingDocument() && frame.pendingDocument()!.documentId === documentId) {
      // Do not override request with undefined.
      return;
    }

    const request = documentId ? Array.from(frame._inflightRequests).find(request => request._documentId === documentId) : undefined;
    frame.setPendingDocument({ documentId, request });
  }

  frameCommittedNewDocumentNavigation(frameId: string, url: string, name: string, documentId: string, initial: boolean) {
    const frame = this._frames.get(frameId)!;
    this.removeChildFramesRecursively(frame);
    this.clearWebSockets(frame);
    frame._url = url;
    frame._name = name;

    let keepPending: DocumentInfo | undefined;
    const pendingDocument = frame.pendingDocument();
    if (pendingDocument) {
      if (pendingDocument.documentId === undefined) {
        // Pending with unknown documentId - assume it is the one being committed.
        pendingDocument.documentId = documentId;
      }
      if (pendingDocument.documentId === documentId) {
        // Committing a pending document.
        frame._currentDocument = pendingDocument;
      } else {
        // Sometimes, we already have a new pending when the old one commits.
        // An example would be Chromium error page followed by a new navigation request,
        // where the error page commit arrives after Network.requestWillBeSent for the
        // new navigation.
        // We commit, but keep the pending request since it's not done yet.
        keepPending = pendingDocument;
        frame._currentDocument = { documentId, request: undefined };
      }
      frame.setPendingDocument(undefined);
    } else {
      // No pending - just commit a new document.
      frame._currentDocument = { documentId, request: undefined };
    }

    frame._onClearLifecycle();
    const navigationEvent: NavigationEvent = { url, name, newDocument: frame._currentDocument, isPublic: true };
    this._fireInternalFrameNavigation(frame, navigationEvent);
    if (!initial) {
      debugLogger.log('api', `  navigated to "${url}"`);
      this._page.frameNavigatedToNewDocument(frame);
    }
    // Restore pending if any - see comments above about keepPending.
    frame.setPendingDocument(keepPending);
  }

  frameCommittedSameDocumentNavigation(frameId: string, url: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    const pending = frame.pendingDocument();
    if (pending && pending.documentId === undefined && pending.request === undefined) {
      // WebKit has notified about the same-document navigation being requested, so clear it.
      frame.setPendingDocument(undefined);
    }
    frame._url = url;
    const navigationEvent: NavigationEvent = { url, name: frame._name, isPublic: true };
    this._fireInternalFrameNavigation(frame, navigationEvent);
    debugLogger.log('api', `  navigated to "${url}"`);
  }

  frameAbortedNavigation(frameId: string, errorText: string, documentId?: string) {
    const frame = this._frames.get(frameId);
    if (!frame || !frame.pendingDocument())
      return;
    if (documentId !== undefined && frame.pendingDocument()!.documentId !== documentId)
      return;
    const navigationEvent: NavigationEvent = {
      url: frame._url,
      name: frame._name,
      newDocument: frame.pendingDocument(),
      error: new NavigationAbortedError(documentId, errorText),
      isPublic: !(documentId && frame._redirectedNavigations.has(documentId)),
    };
    frame.setPendingDocument(undefined);
    this._fireInternalFrameNavigation(frame, navigationEvent);
  }

  frameDetached(frameId: string) {
    const frame = this._frames.get(frameId);
    if (frame) {
      this._removeFramesRecursively(frame);
      this._page.mainFrame()._recalculateNetworkIdle();
    }
  }

  frameLifecycleEvent(frameId: string, event: RegularLifecycleEvent) {
    const frame = this._frames.get(frameId);
    if (frame)
      frame._onLifecycleEvent(event);
  }

  requestStarted(request: network.Request, route?: network.RouteDelegate) {
    const frame = request.frame()!;
    this._inflightRequestStarted(request);
    if (request._documentId)
      frame.setPendingDocument({ documentId: request._documentId, request });
    if (request._isFavicon) {
      // Abort favicon requests to avoid network access in case of interception.
      route?.abort('aborted').catch(() => {});
      return;
    }
    this._page.emitOnContext(BrowserContext.Events.Request, request);
    if (route)
      new network.Route(request, route).handle([...this._page.requestInterceptors, ...this._page.browserContext.requestInterceptors]);
  }

  requestReceivedResponse(response: network.Response) {
    if (response.request()._isFavicon)
      return;
    this._page.emitOnContext(BrowserContext.Events.Response, response);
  }

  reportRequestFinished(request: network.Request, response: network.Response | null) {
    this._inflightRequestFinished(request);
    if (request._isFavicon)
      return;
    this._page.emitOnContext(BrowserContext.Events.RequestFinished, { request, response });
  }

  requestFailed(request: network.Request, canceled: boolean) {
    const frame = request.frame()!;
    this._inflightRequestFinished(request);
    if (frame.pendingDocument() && frame.pendingDocument()!.request === request) {
      let errorText = request.failure()!.errorText;
      if (canceled)
        errorText += '; maybe frame was detached?';
      this.frameAbortedNavigation(frame._id, errorText, frame.pendingDocument()!.documentId);
    }
    if (request._isFavicon)
      return;
    this._page.emitOnContext(BrowserContext.Events.RequestFailed, request);
  }

  removeChildFramesRecursively(frame: Frame) {
    for (const child of frame.childFrames())
      this._removeFramesRecursively(child);
  }

  private _removeFramesRecursively(frame: Frame) {
    this.removeChildFramesRecursively(frame);
    frame._onDetached();
    this._frames.delete(frame._id);
    if (!this._page.isClosed())
      this._page.emit(Page.Events.FrameDetached, frame);
  }

  private _inflightRequestFinished(request: network.Request) {
    const frame = request.frame()!;
    if (request._isFavicon)
      return;
    if (!frame._inflightRequests.has(request))
      return;
    frame._inflightRequests.delete(request);
    if (frame._inflightRequests.size === 0)
      frame._startNetworkIdleTimer();
  }

  private _inflightRequestStarted(request: network.Request) {
    const frame = request.frame()!;
    if (request._isFavicon)
      return;
    frame._inflightRequests.add(request);
    if (frame._inflightRequests.size === 1)
      frame._stopNetworkIdleTimer();
  }

  interceptConsoleMessage(message: ConsoleMessage): boolean {
    if (message.type() !== 'debug')
      return false;
    const tag = message.text();
    const handler = this._consoleMessageTags.get(tag);
    if (!handler)
      return false;
    this._consoleMessageTags.delete(tag);
    handler();
    return true;
  }

  clearWebSockets(frame: Frame) {
    // TODO: attribute sockets to frames.
    if (frame.parentFrame())
      return;
    this._webSockets.clear();
  }

  onWebSocketCreated(requestId: string, url: string) {
    const ws = new network.WebSocket(this._page, url);
    this._webSockets.set(requestId, ws);
  }

  onWebSocketRequest(requestId: string) {
    const ws = this._webSockets.get(requestId);
    if (ws && ws.markAsNotified())
      this._page.emit(Page.Events.WebSocket, ws);
  }

  onWebSocketResponse(requestId: string, status: number, statusText: string) {
    const ws = this._webSockets.get(requestId);
    if (status < 400)
      return;
    if (ws)
      ws.error(`${statusText}: ${status}`);
  }

  onWebSocketFrameSent(requestId: string, opcode: number, data: string) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.frameSent(opcode, data);
  }

  webSocketFrameReceived(requestId: string, opcode: number, data: string) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.frameReceived(opcode, data);
  }

  webSocketClosed(requestId: string) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.closed();
    this._webSockets.delete(requestId);
  }

  webSocketError(requestId: string, errorMessage: string): void {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.error(errorMessage);
  }

  private _fireInternalFrameNavigation(frame: Frame, event: NavigationEvent) {
    frame.emit(Frame.Events.InternalNavigation, event);
  }
}

export class Frame extends SdkObject {
  static Events = {
    InternalNavigation: 'internalnavigation',
    AddLifecycle: 'addlifecycle',
    RemoveLifecycle: 'removelifecycle',
  };

  _id: string;
  _firedLifecycleEvents = new Set<types.LifecycleEvent>();
  private _firedNetworkIdleSelf = false;
  _currentDocument: DocumentInfo;
  private _pendingDocument: DocumentInfo | undefined;
  readonly _page: Page;
  private _parentFrame: Frame | null;
  _url = '';
  private _contextData = new Map<types.World, ContextData>();
  private _childFrames = new Set<Frame>();
  _name = '';
  _inflightRequests = new Set<network.Request>();
  private _networkIdleTimer: NodeJS.Timeout | undefined;
  private _setContentCounter = 0;
  readonly _detachedScope = new LongStandingScope();
  private _raceAgainstEvaluationStallingEventsPromises = new Set<ManualPromise<any>>();
  readonly _redirectedNavigations = new Map<string, { url: string, gotoPromise: Promise<network.Response | null> }>(); // documentId -> data
  readonly selectors: FrameSelectors;

  constructor(page: Page, id: string, parentFrame: Frame | null) {
    super(page, 'frame');
    this.attribution.frame = this;
    this._id = id;
    this._page = page;
    this._parentFrame = parentFrame;
    this._currentDocument = { documentId: undefined, request: undefined };
    this.selectors = new FrameSelectors(this);

    this._contextData.set('main', { contextPromise: new ManualPromise(), context: null });
    this._contextData.set('utility', { contextPromise: new ManualPromise(), context: null });
    this._setContext('main', null);
    this._setContext('utility', null);

    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);

    this._firedLifecycleEvents.add('commit');
    if (id !== kDummyFrameId)
      this._startNetworkIdleTimer();
  }

  isDetached(): boolean {
    return this._detachedScope.isClosed();
  }

  _onLifecycleEvent(event: RegularLifecycleEvent) {
    if (this._firedLifecycleEvents.has(event))
      return;
    this._firedLifecycleEvents.add(event);
    this.emit(Frame.Events.AddLifecycle, event);
    if (this === this._page.mainFrame() && this._url !== 'about:blank')
      debugLogger.log('api', `  "${event}" event fired`);
    this._page.mainFrame()._recalculateNetworkIdle();
  }

  _onClearLifecycle() {
    for (const event of this._firedLifecycleEvents)
      this.emit(Frame.Events.RemoveLifecycle, event);
    this._firedLifecycleEvents.clear();
    // Keep the current navigation request if any.
    this._inflightRequests = new Set(Array.from(this._inflightRequests).filter(request => request === this._currentDocument.request));
    this._stopNetworkIdleTimer();
    if (this._inflightRequests.size === 0)
      this._startNetworkIdleTimer();
    this._page.mainFrame()._recalculateNetworkIdle(this);
    this._onLifecycleEvent('commit');
  }

  setPendingDocument(documentInfo: DocumentInfo | undefined) {
    this._pendingDocument = documentInfo;
    if (documentInfo)
      this._invalidateNonStallingEvaluations('Navigation interrupted the evaluation');
  }

  pendingDocument(): DocumentInfo | undefined {
    return this._pendingDocument;
  }

  _invalidateNonStallingEvaluations(message: string) {
    if (!this._raceAgainstEvaluationStallingEventsPromises.size)
      return;
    const error = new Error(message);
    for (const promise of this._raceAgainstEvaluationStallingEventsPromises)
      promise.reject(error);
  }

  async raceAgainstEvaluationStallingEvents<T>(cb: () => Promise<T>): Promise<T> {
    if (this._pendingDocument)
      throw new Error('Frame is currently attempting a navigation');
    if (this._page.browserContext.dialogManager.hasOpenDialogsForPage(this._page))
      throw new Error('Open JavaScript dialog prevents evaluation');

    const promise = new ManualPromise<T>();
    this._raceAgainstEvaluationStallingEventsPromises.add(promise);
    try {
      return await Promise.race([
        cb(),
        promise
      ]);
    } finally {
      this._raceAgainstEvaluationStallingEventsPromises.delete(promise);
    }
  }

  nonStallingRawEvaluateInExistingMainContext(expression: string): Promise<any> {
    return this.raceAgainstEvaluationStallingEvents(() => {
      const context = this._existingMainContext();
      if (!context)
        throw new Error('Frame does not yet have a main execution context');
      return context.rawEvaluateJSON(expression);
    });
  }

  nonStallingEvaluateInExistingContext(expression: string, world: types.World): Promise<any> {
    return this.raceAgainstEvaluationStallingEvents(() => {
      const context = this._contextData.get(world)?.context;
      if (!context)
        throw new Error('Frame does not yet have the execution context');
      return context.evaluateExpression(expression, { isFunction: false });
    });
  }

  _recalculateNetworkIdle(frameThatAllowsRemovingNetworkIdle?: Frame) {
    let isNetworkIdle = this._firedNetworkIdleSelf;
    for (const child of this._childFrames) {
      child._recalculateNetworkIdle(frameThatAllowsRemovingNetworkIdle);
      // We require networkidle event to be fired in the whole frame subtree, and then consider it done.
      if (!child._firedLifecycleEvents.has('networkidle'))
        isNetworkIdle = false;
    }
    if (isNetworkIdle && !this._firedLifecycleEvents.has('networkidle')) {
      this._firedLifecycleEvents.add('networkidle');
      this.emit(Frame.Events.AddLifecycle, 'networkidle');
      if (this === this._page.mainFrame() && this._url !== 'about:blank')
        debugLogger.log('api', `  "networkidle" event fired`);
    }
    if (frameThatAllowsRemovingNetworkIdle !== this && this._firedLifecycleEvents.has('networkidle') && !isNetworkIdle) {
      // Usually, networkidle is fired once and not removed after that.
      // However, when we clear them right before a new commit, this is allowed for a particular frame.
      this._firedLifecycleEvents.delete('networkidle');
      this.emit(Frame.Events.RemoveLifecycle, 'networkidle');
    }
  }

  async raceNavigationAction(progress: Progress, action: () => Promise<network.Response | null>): Promise<network.Response | null> {
    return LongStandingScope.raceMultiple([
      this._detachedScope,
      this._page.openScope,
    ], action().catch(e => {
      if (e instanceof NavigationAbortedError && e.documentId) {
        const data = this._redirectedNavigations.get(e.documentId);
        if (data) {
          progress.log(`waiting for redirected navigation to "${data.url}"`);
          return progress.race(data.gotoPromise);
        }
      }
      throw e;
    }));
  }

  redirectNavigation(url: string, documentId: string, referer: string | undefined) {
    const controller = new ProgressController(serverSideCallMetadata(), this);
    const data = {
      url,
      gotoPromise: controller.run(progress => this.gotoImpl(progress, url, { referer }), 0),
    };
    this._redirectedNavigations.set(documentId, data);
    data.gotoPromise.finally(() => this._redirectedNavigations.delete(documentId));
  }

  async goto(progress: Progress, url: string, options: types.GotoOptions = {}): Promise<network.Response | null> {
    const constructedNavigationURL = constructURLBasedOnBaseURL(this._page.browserContext._options.baseURL, url);
    return this.raceNavigationAction(progress, async () => this.gotoImpl(progress, constructedNavigationURL, options));
  }

  async gotoImpl(progress: Progress, url: string, options: types.GotoOptions): Promise<network.Response | null> {
    const waitUntil = verifyLifecycle('waitUntil', options.waitUntil === undefined ? 'load' : options.waitUntil);
    progress.log(`navigating to "${url}", waiting until "${waitUntil}"`);
    const headers = this._page.extraHTTPHeaders() || [];
    const refererHeader = headers.find(h => h.name.toLowerCase() === 'referer');
    let referer = refererHeader ? refererHeader.value : undefined;
    if (options.referer !== undefined) {
      if (referer !== undefined && referer !== options.referer)
        throw new Error('"referer" is already specified as extra HTTP header');
      referer = options.referer;
    }
    url = helper.completeUserURL(url);

    const navigationEvents: NavigationEvent[] = [];
    const collectNavigations = (arg: NavigationEvent) => navigationEvents.push(arg);
    this.on(Frame.Events.InternalNavigation, collectNavigations);
    const navigateResult = await progress.race(this._page.delegate.navigateFrame(this, url, referer)).finally(
        () => this.off(Frame.Events.InternalNavigation, collectNavigations));

    let event: NavigationEvent;
    if (navigateResult.newDocumentId) {
      const predicate = (event: NavigationEvent) => {
        // We are interested either in this specific document, or any other document that
        // did commit and replaced the expected document.
        return event.newDocument && (event.newDocument.documentId === navigateResult.newDocumentId || !event.error);
      };
      const events = navigationEvents.filter(predicate);
      if (events.length)
        event = events[0];
      else
        event = await helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, predicate).promise;
      if (event.newDocument!.documentId !== navigateResult.newDocumentId) {
        // This is just a sanity check. In practice, new navigation should
        // cancel the previous one and report "request cancelled"-like error.
        throw new NavigationAbortedError(navigateResult.newDocumentId, `Navigation to "${url}" is interrupted by another navigation to "${event.url}"`);
      }
      if (event.error)
        throw event.error;
    } else {
      // Wait for same document navigation.
      const predicate = (e: NavigationEvent) => !e.newDocument;
      const events = navigationEvents.filter(predicate);
      if (events.length)
        event = events[0];
      else
        event = await helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, predicate).promise;
    }

    if (!this._firedLifecycleEvents.has(waitUntil))
      await helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e: types.LifecycleEvent) => e === waitUntil).promise;

    const request = event.newDocument ? event.newDocument.request : undefined;
    const response = request ? progress.race(request._finalRequest().response()) : null;
    return response;
  }

  async _waitForNavigation(progress: Progress, requiresNewDocument: boolean, options: types.NavigateOptions): Promise<network.Response | null> {
    const waitUntil = verifyLifecycle('waitUntil', options.waitUntil === undefined ? 'load' : options.waitUntil);
    progress.log(`waiting for navigation until "${waitUntil}"`);

    const navigationEvent: NavigationEvent = await helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, (event: NavigationEvent) => {
      // Any failed navigation results in a rejection.
      if (event.error)
        return true;
      if (requiresNewDocument && !event.newDocument)
        return false;
      progress.log(`  navigated to "${this._url}"`);
      return true;
    }).promise;
    if (navigationEvent.error)
      throw navigationEvent.error;

    if (!this._firedLifecycleEvents.has(waitUntil))
      await helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e: types.LifecycleEvent) => e === waitUntil).promise;

    const request = navigationEvent.newDocument ? navigationEvent.newDocument.request : undefined;
    return request ? progress.race(request._finalRequest().response()) : null;
  }

  async _waitForLoadState(progress: Progress, state: types.LifecycleEvent): Promise<void> {
    const waitUntil = verifyLifecycle('state', state);
    if (!this._firedLifecycleEvents.has(waitUntil))
      await helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e: types.LifecycleEvent) => e === waitUntil).promise;
  }

  async frameElement(): Promise<dom.ElementHandle> {
    return this._page.delegate.getFrameElement(this);
  }

  _context(world: types.World): Promise<dom.FrameExecutionContext> {
    return this._contextData.get(world)!.contextPromise.then(contextOrDestroyedReason => {
      if (contextOrDestroyedReason instanceof js.ExecutionContext)
        return contextOrDestroyedReason;
      throw new Error(contextOrDestroyedReason.destroyedReason);
    });
  }

  _mainContext(): Promise<dom.FrameExecutionContext> {
    return this._context('main');
  }

  private _existingMainContext(): dom.FrameExecutionContext | null {
    return this._contextData.get('main')?.context || null;
  }

  _utilityContext(): Promise<dom.FrameExecutionContext> {
    return this._context('utility');
  }

  async evaluateExpression(expression: string, options: { isFunction?: boolean, world?: types.World } = {}, arg?: any): Promise<any> {
    const context = await this._context(options.world ?? 'main');
    const value = await context.evaluateExpression(expression, options, arg);
    return value;
  }

  async evaluateExpressionHandle(expression: string, options: { isFunction?: boolean, world?: types.World } = {}, arg?: any): Promise<js.JSHandle<any>> {
    const context = await this._context(options.world ?? 'main');
    const value = await context.evaluateExpressionHandle(expression, options, arg);
    return value;
  }

  async querySelector(selector: string, options: types.StrictOptions): Promise<dom.ElementHandle<Element> | null> {
    debugLogger.log('api', `    finding element using the selector "${selector}"`);
    return this.selectors.query(selector, options);
  }

  async waitForSelector(progress: Progress, selector: string, performActionPreChecksAndLog: boolean, options: types.WaitForElementOptions, scope?: dom.ElementHandle): Promise<dom.ElementHandle<Element> | null> {
    if ((options as any).visibility)
      throw new Error('options.visibility is not supported, did you mean options.state?');
    if ((options as any).waitFor && (options as any).waitFor !== 'visible')
      throw new Error('options.waitFor is not supported, did you mean options.state?');
    const { state = 'visible' } = options;
    if (!['attached', 'detached', 'visible', 'hidden'].includes(state))
      throw new Error(`state: expected one of (attached|detached|visible|hidden)`);
    if (performActionPreChecksAndLog)
      progress.log(`waiting for ${this._asLocator(selector)}${state === 'attached' ? '' : ' to be ' + state}`);
    const promise = this.retryWithProgressAndTimeouts(progress, [0, 20, 50, 100, 100, 500], async continuePolling => {
      if (performActionPreChecksAndLog)
        await this._page.performActionPreChecks(progress);

      const resolved = await progress.race(this.selectors.resolveInjectedForSelector(selector, options, scope));
      if (!resolved) {
        if (state === 'hidden' || state === 'detached')
          return null;
        return continuePolling;
      }
      const result = await progress.race(resolved.injected.evaluateHandle((injected, { info, root }) => {
        if (root && !root.isConnected)
          throw injected.createStacklessError('Element is not attached to the DOM');
        const elements = injected.querySelectorAll(info.parsed, root || document);
        const element: Element | undefined  = elements[0];
        const visible = element ? injected.utils.isElementVisible(element) : false;
        let log = '';
        if (elements.length > 1) {
          if (info.strict)
            throw injected.strictModeViolationError(info.parsed, elements);
          log = `  locator resolved to ${elements.length} elements. Proceeding with the first one: ${injected.previewNode(elements[0])}`;
        } else if (element) {
          log = `  locator resolved to ${visible ? 'visible' : 'hidden'} ${injected.previewNode(element)}`;
        }
        return { log, element, visible, attached: !!element };
      }, { info: resolved.info, root: resolved.frame === this ? scope : undefined }));
      const { log, visible, attached } = await progress.race(result.evaluate(r => ({ log: r.log, visible: r.visible, attached: r.attached })));
      if (log)
        progress.log(log);
      const success = { attached, detached: !attached, visible, hidden: !visible }[state];
      if (!success) {
        result.dispose();
        return continuePolling;
      }
      if (options.omitReturnValue) {
        result.dispose();
        return null;
      }
      const element = state === 'attached' || state === 'visible' ? await progress.race(result.evaluateHandle(r => r.element)) : null;
      result.dispose();
      if (!element)
        return null;
      if ((options as any).__testHookBeforeAdoptNode)
        await progress.race((options as any).__testHookBeforeAdoptNode());
      try {
        const mainContext = await progress.race(resolved.frame._mainContext());
        return await progress.race(element._adoptTo(mainContext));
      } catch (e) {
        return continuePolling;
      }
    });
    return scope ? scope._context._raceAgainstContextDestroyed(promise) : promise;
  }

  async dispatchEvent(progress: Progress, selector: string, type: string, eventInit: Object = {}, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<void> {
    await this._callOnElementOnceMatches(progress, selector, (injectedScript, element, data) => {
      injectedScript.dispatchEvent(element, data.type, data.eventInit);
    }, { type, eventInit }, { mainWorld: true, ...options }, scope);
  }

  async evalOnSelector(selector: string, strict: boolean, expression: string, isFunction: boolean | undefined, arg: any, scope?: dom.ElementHandle): Promise<any> {
    const handle = await this.selectors.query(selector, { strict }, scope);
    if (!handle)
      throw new Error(`Failed to find element matching selector "${selector}"`);
    const result = await handle.evaluateExpression(expression, { isFunction }, arg);
    handle.dispose();
    return result;
  }

  async evalOnSelectorAll(selector: string, expression: string, isFunction: boolean | undefined, arg: any, scope?: dom.ElementHandle): Promise<any> {
    const arrayHandle = await this.selectors.queryArrayInMainWorld(selector, scope);
    const result = await arrayHandle.evaluateExpression(expression, { isFunction }, arg);
    arrayHandle.dispose();
    return result;
  }

  async maskSelectors(selectors: ParsedSelector[], color: string): Promise<void> {
    const context = await this._utilityContext();
    const injectedScript = await context.injectedScript();
    await injectedScript.evaluate((injected, { parsed, color }) => {
      injected.maskSelectors(parsed, color);
    }, { parsed: selectors, color: color });
  }

  async querySelectorAll(selector: string): Promise<dom.ElementHandle<Element>[]> {
    return this.selectors.queryAll(selector);
  }

  async queryCount(selector: string): Promise<number> {
    return await this.selectors.queryCount(selector);
  }

  async content(): Promise<string> {
    try {
      const context = await this._utilityContext();
      return await context.evaluate(() => {
        let retVal = '';
        if (document.doctype)
          retVal = new XMLSerializer().serializeToString(document.doctype);
        if (document.documentElement)
          retVal += document.documentElement.outerHTML;
        return retVal;
      });
    } catch (e) {
      if (this.isNonRetriableError(e))
        throw e;
      throw new Error(`Unable to retrieve content because the page is navigating and changing the content.`);
    }
  }

  async setContent(progress: Progress, html: string, options: types.NavigateOptions): Promise<void> {
    await this.raceNavigationAction(progress, async () => {
      const waitUntil = options.waitUntil === undefined ? 'load' : options.waitUntil;
      progress.log(`setting frame content, waiting until "${waitUntil}"`);
      const tag = `--playwright--set--content--${this._id}--${++this._setContentCounter}--`;
      const context = await progress.race(this._utilityContext());
      const tagPromise = new ManualPromise<void>();
      this._page.frameManager._consoleMessageTags.set(tag, () => {
        // Clear lifecycle right after document.open() - see 'tag' below.
        this._onClearLifecycle();
        tagPromise.resolve();
      });
      progress.cleanupWhenAborted(() => this._page.frameManager._consoleMessageTags.delete(tag));
      const lifecyclePromise = progress.race(tagPromise).then(() => this._waitForLoadState(progress, waitUntil));
      const contentPromise = progress.race(context.evaluate(({ html, tag }) => {
        document.open();
        console.debug(tag);  // eslint-disable-line no-console
        document.write(html);
        document.close();
      }, { html, tag }));
      await Promise.all([contentPromise, lifecyclePromise]);
      return null;
    });
  }

  name(): string {
    return this._name || '';
  }

  url(): string {
    return this._url;
  }

  origin(): string | undefined {
    if (!this._url.startsWith('http'))
      return;
    return network.parseURL(this._url)?.origin;
  }

  parentFrame(): Frame | null {
    return this._parentFrame;
  }

  childFrames(): Frame[] {
    return Array.from(this._childFrames);
  }

  async addScriptTag(params: {
      url?: string,
      content?: string,
      type?: string,
    }): Promise<dom.ElementHandle> {
    const {
      url = null,
      content = null,
      type = ''
    } = params;
    if (!url && !content)
      throw new Error('Provide an object with a `url`, `path` or `content` property');

    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandle(addScriptUrl, { url, type })).asElement()!;
      const result = (await context.evaluateHandle(addScriptContent, { content: content!, type })).asElement()!;
      // Another round trip to the browser to ensure that we receive CSP error messages
      // (if any) logged asynchronously in a separate task on the content main thread.
      if (this._page.delegate.cspErrorsAsynchronousForInlineScripts)
        await context.evaluate(() => true);
      return result;
    });

    async function addScriptUrl(params: { url: string, type: string }): Promise<HTMLElement> {
      const script = document.createElement('script');
      script.src = params.url;
      if (params.type)
        script.type = params.type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = e => rej(typeof e === 'string' ? new Error(e) : new Error(`Failed to load script at ${script.src}`));
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }

    function addScriptContent(params: { content: string, type: string }): HTMLElement {
      const script = document.createElement('script');
      script.type = params.type || 'text/javascript';
      script.text = params.content;
      let error = null;
      script.onerror = e => error = e;
      document.head.appendChild(script);
      if (error)
        throw error;
      return script;
    }
  }

  async addStyleTag(params: { url?: string, content?: string }): Promise<dom.ElementHandle> {
    const {
      url = null,
      content = null
    } = params;
    if (!url && !content)
      throw new Error('Provide an object with a `url`, `path` or `content` property');

    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandle(addStyleUrl, url)).asElement()!;
      return (await context.evaluateHandle(addStyleContent, content!)).asElement()!;
    });

    async function addStyleUrl(url: string): Promise<HTMLElement> {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }

    async function addStyleContent(content: string): Promise<HTMLElement> {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }

  private async _raceWithCSPError(func: () => Promise<dom.ElementHandle>): Promise<dom.ElementHandle> {
    const listeners: RegisteredListener[] = [];
    let result: dom.ElementHandle;
    let error: Error | undefined;
    let cspMessage: ConsoleMessage | undefined;
    const actionPromise = func().then(r => result = r).catch(e => error = e);
    const errorPromise = new Promise<void>(resolve => {
      listeners.push(eventsHelper.addEventListener(this._page.browserContext, BrowserContext.Events.Console, (message: ConsoleMessage) => {
        if (message.page() !== this._page || message.type() !== 'error')
          return;
        if (message.text().includes('Content-Security-Policy') || message.text().includes('Content Security Policy')) {
          cspMessage = message;
          resolve();
        }
      }));
    });
    await Promise.race([actionPromise, errorPromise]);
    eventsHelper.removeEventListeners(listeners);
    if (cspMessage)
      throw new Error(cspMessage.text());
    if (error)
      throw error;
    return result!;
  }

  async retryWithProgressAndTimeouts<R>(progress: Progress, timeouts: number[], action: (continuePolling: symbol) => Promise<R | symbol>): Promise<R> {
    const continuePolling = Symbol('continuePolling');
    timeouts = [0, ...timeouts];
    let timeoutIndex = 0;
    while (true) {
      const timeout = timeouts[Math.min(timeoutIndex++, timeouts.length - 1)];
      if (timeout) {
        // Make sure we react immediately upon page close or frame detach.
        // We need this to show expected/received values in time.
        const actionPromise = new Promise(f => setTimeout(f, timeout));
        await progress.race(LongStandingScope.raceMultiple([
          this._page.openScope,
          this._detachedScope,
        ], actionPromise));
      }
      try {
        const result = await action(continuePolling);
        if (result === continuePolling)
          continue;
        return result as R;
      } catch (e) {
        if (this.isNonRetriableError(e))
          throw e;
        continue;
      }
    }
  }

  isNonRetriableError(e: Error) {
    if (isAbortError(e))
      return true;
    // Always fail on JavaScript errors or when the main connection is closed.
    if (js.isJavaScriptErrorInEvaluate(e) || isSessionClosedError(e))
      return true;
    // Certain errors opt-out of the retries, throw.
    if (dom.isNonRecoverableDOMError(e) || isInvalidSelectorError(e))
      return true;
    // If the call is made on the detached frame - throw.
    if (this.isDetached())
      return true;
    // Retry upon all other errors.
    return false;
  }

  private async _retryWithProgressIfNotConnected<R>(
    progress: Progress,
    selector: string,
    strict: boolean | undefined,
    performActionPreChecks: boolean,
    action: (handle: dom.ElementHandle<Element>) => Promise<R | 'error:notconnected'>): Promise<R> {
    progress.log(`waiting for ${this._asLocator(selector)}`);
    return this.retryWithProgressAndTimeouts(progress, [0, 20, 50, 100, 100, 500], async continuePolling => {
      if (performActionPreChecks)
        await this._page.performActionPreChecks(progress);

      const resolved = await progress.race(this.selectors.resolveInjectedForSelector(selector, { strict }));
      if (!resolved)
        return continuePolling;
      const result = await progress.race(resolved.injected.evaluateHandle((injected, { info, callId }) => {
        const elements = injected.querySelectorAll(info.parsed, document);
        if (callId)
          injected.markTargetElements(new Set(elements), callId);
        const element = elements[0] as Element | undefined;
        let log = '';
        if (elements.length > 1) {
          if (info.strict)
            throw injected.strictModeViolationError(info.parsed, elements);
          log = `  locator resolved to ${elements.length} elements. Proceeding with the first one: ${injected.previewNode(elements[0])}`;
        } else if (element) {
          log = `  locator resolved to ${injected.previewNode(element)}`;
        }
        return { log, success: !!element, element };
      }, { info: resolved.info, callId: progress.metadata.id }));
      const { log, success } = await progress.race(result.evaluate(r => ({ log: r.log, success: r.success })));
      if (log)
        progress.log(log);
      if (!success) {
        result.dispose();
        return continuePolling;
      }
      const element = await progress.race(result.evaluateHandle(r => r.element)) as dom.ElementHandle<Element>;
      result.dispose();
      try {
        const result = await action(element);
        if (result === 'error:notconnected') {
          progress.log('element was detached from the DOM, retrying');
          return continuePolling;
        }
        return result;
      } finally {
        element?.dispose();
      }
    });
  }

  async rafrafTimeoutScreenshotElementWithProgress(progress: Progress, selector: string, timeout: number, options: ScreenshotOptions): Promise<Buffer> {
    return await this._retryWithProgressIfNotConnected(progress, selector, true /* strict */, true /* performActionPreChecks */, async handle => {
      await handle._frame.rafrafTimeout(progress, timeout);
      return await this._page.screenshotter.screenshotElement(progress, handle, options);
    });
  }

  async click(progress: Progress, selector: string, options: { noWaitAfter?: boolean } & types.MouseClickOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._click(progress, { ...options, waitAfter: !options.noWaitAfter })));
  }

  async dblclick(progress: Progress, selector: string, options: types.MouseMultiClickOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._dblclick(progress, options)));
  }

  async dragAndDrop(progress: Progress, source: string, target: string, options: types.DragActionOptions & types.PointerActionWaitOptions) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, source, options.strict, !options.force /* performActionPreChecks */, async handle => {
      return handle._retryPointerAction(progress, 'move and down', false, async point => {
        await this._page.mouse.move(progress, point.x, point.y);
        await this._page.mouse.down(progress);
      }, {
        ...options,
        waitAfter: 'disabled',
        position: options.sourcePosition,
      });
    }));
    // Note: do not perform locator handlers checkpoint to avoid moving the mouse in the middle of a drag operation.
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, target, options.strict, false /* performActionPreChecks */, async handle => {
      return handle._retryPointerAction(progress, 'move and up', false, async point => {
        await this._page.mouse.move(progress, point.x, point.y);
        await this._page.mouse.up(progress);
      }, {
        ...options,
        waitAfter: 'disabled',
        position: options.targetPosition,
      });
    }));
  }

  async tap(progress: Progress, selector: string, options: types.PointerActionWaitOptions) {
    if (!this._page.browserContext._options.hasTouch)
      throw new Error('The page does not support tap. Use hasTouch context option to enable touch support.');
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._tap(progress, options)));
  }

  async fill(progress: Progress, selector: string, value: string, options: types.StrictOptions & { force?: boolean }) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._fill(progress, value, options)));
  }

  async focus(progress: Progress, selector: string, options: types.StrictOptions) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._focus(progress)));
  }

  async blur(progress: Progress, selector: string, options: types.StrictOptions) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._blur(progress)));
  }

  async resolveSelector(progress: Progress, selector: string, options: { mainWorld?: boolean } = {}): Promise<{ resolvedSelector: string }> {
    const element = await progress.race(this.selectors.query(selector, options));
    if (!element)
      throw new Error(`No element matching ${selector}`);

    const generated = await progress.race(element.evaluateInUtility(async ([injected, node]) => {
      return injected.generateSelectorSimple(node as unknown as Element);
    }, {}));
    if (!generated)
      throw new Error(`Unable to generate locator for ${selector}`);

    let frame: Frame | null = element._frame;
    const result = [generated];
    while (frame?.parentFrame()) {
      const frameElement = await progress.race(frame.frameElement());
      if (frameElement) {
        const generated = await progress.race(frameElement.evaluateInUtility(async ([injected, node]) => {
          return injected.generateSelectorSimple(node as unknown as Element);
        }, {}));
        frameElement.dispose();
        if (generated === 'error:notconnected' || !generated)
          throw new Error(`Unable to generate locator for ${selector}`);
        result.push(generated);
      }
      frame = frame.parentFrame();
    }
    const resolvedSelector = result.reverse().join(' >> internal:control=enter-frame >> ');
    return { resolvedSelector };
  }

  async textContent(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string | null> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element) => element.textContent, undefined, options, scope);
  }

  async innerText(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injectedScript, element) => {
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
        throw injectedScript.createStacklessError('Node is not an HTMLElement');
      return (element as HTMLElement).innerText;
    }, undefined, options, scope);
  }

  async innerHTML(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element) => element.innerHTML, undefined, options, scope);
  }

  async getAttribute(progress: Progress, selector: string, name: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string | null> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element, data) => element.getAttribute(data.name), { name }, options, scope);
  }

  async inputValue(progress: Progress, selector: string, options: types.StrictOptions, scope?: dom.ElementHandle): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injectedScript, node) => {
      const element = injectedScript.retarget(node, 'follow-label');
      if (!element || (element.nodeName !== 'INPUT' && element.nodeName !== 'TEXTAREA' && element.nodeName !== 'SELECT'))
        throw injectedScript.createStacklessError('Node is not an <input>, <textarea> or <select> element');
      return (element as any).value;
    }, undefined, options, scope);
  }

  async highlight(progress: Progress, selector: string) {
    const resolved = await progress.race(this.selectors.resolveInjectedForSelector(selector));
    if (!resolved)
      return;
    return await progress.race(resolved.injected.evaluate((injected, { info }) => {
      return injected.highlight(info.parsed);
    }, { info: resolved.info }));
  }

  async hideHighlight() {
    return this.raceAgainstEvaluationStallingEvents(async () => {
      const context = await this._utilityContext();
      const injectedScript = await context.injectedScript();
      return await injectedScript.evaluate(injected => {
        return injected.hideHighlight();
      });
    });
  }

  private async _elementState(progress: Progress, selector: string, state: ElementStateWithoutStable, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    const result = await this._callOnElementOnceMatches(progress, selector, (injected, element, data) => {
      return injected.elementState(element, data.state);
    }, { state }, options, scope);
    if (result.received === 'error:notconnected')
      dom.throwElementIsNotAttached();
    return result.matches;
  }

  async isVisible(progress: Progress, selector: string, options: types.StrictOptions = {}, scope?: dom.ElementHandle): Promise<boolean> {
    progress.log(`  checking visibility of ${this._asLocator(selector)}`);
    return await this.isVisibleInternal(progress, selector, options, scope);
  }

  async isVisibleInternal(progress: Progress, selector: string, options: types.StrictOptions = {}, scope?: dom.ElementHandle): Promise<boolean> {
    try {
      const resolved = await progress.race(this.selectors.resolveInjectedForSelector(selector, options, scope));
      if (!resolved)
        return false;
      return await progress.race(resolved.injected.evaluate((injected, { info, root }) => {
        const element = injected.querySelector(info.parsed, root || document, info.strict);
        const state = element ? injected.elementState(element, 'visible') : { matches: false, received: 'error:notconnected' };
        return state.matches;
      }, { info: resolved.info, root: resolved.frame === this ? scope : undefined }));
    } catch (e) {
      if (this.isNonRetriableError(e))
        throw e;
      return false;
    }
  }

  async isHidden(progress: Progress, selector: string, options: types.StrictOptions = {}, scope?: dom.ElementHandle): Promise<boolean> {
    return !(await this.isVisible(progress, selector, options, scope));
  }

  async isDisabled(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'disabled', options, scope);
  }

  async isEnabled(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'enabled', options, scope);
  }

  async isEditable(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'editable', options, scope);
  }

  async isChecked(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'checked', options, scope);
  }

  async hover(progress: Progress, selector: string, options: types.PointerActionOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._hover(progress, options)));
  }

  async selectOption(progress: Progress, selector: string, elements: dom.ElementHandle[], values: types.SelectOption[], options: types.CommonActionOptions): Promise<string[]> {
    return await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._selectOption(progress, elements, values, options));
  }

  async setInputFiles(progress: Progress, selector: string, params: Omit<channels.FrameSetInputFilesParams, 'timeout'>): Promise<channels.FrameSetInputFilesResult> {
    const inputFileItems = await prepareFilesForUpload(this, params);
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, params.strict, true /* performActionPreChecks */, handle => handle._setInputFiles(progress, inputFileItems)));
  }

  async type(progress: Progress, selector: string, text: string, options: { delay?: number } & types.StrictOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._type(progress, text, options)));
  }

  async press(progress: Progress, selector: string, key: string, options: { delay?: number, noWaitAfter?: boolean } & types.StrictOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._press(progress, key, options)));
  }

  async check(progress: Progress, selector: string, options: types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._setChecked(progress, true, options)));
  }

  async uncheck(progress: Progress, selector: string, options: types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._setChecked(progress, false, options)));
  }

  async waitForTimeout(progress: Progress, timeout: number) {
    return progress.wait(timeout);
  }

  async ariaSnapshot(progress: Progress, selector: string): Promise<string> {
    return await this._retryWithProgressIfNotConnected(progress, selector, true /* strict */, true /* performActionPreChecks */, handle => progress.race(handle.ariaSnapshot()));
  }

  async expect(progress: Progress, selector: string | undefined, options: FrameExpectParams, timeout?: number): Promise<ExpectResult> {
    progress.log(`${renderTitleForCall(progress.metadata)}${timeout ? ` with timeout ${timeout}ms` : ''}`);
    const lastIntermediateResult: { received?: any, isSet: boolean } = { isSet: false };
    const fixupMetadataError = (result: ExpectResult) => {
      // Library mode special case for the expect errors which are return values, not exceptions.
      if (result.matches === options.isNot)
        progress.metadata.error = { error: { name: 'Expect', message: 'Expect failed' } };
    };
    try {
      // Step 1: perform locator handlers checkpoint with a specified timeout.
      if (selector)
        progress.log(`waiting for ${this._asLocator(selector)}`);
      await this._page.performActionPreChecks(progress);

      // Step 2: perform one-shot expect check without a timeout.
      // Supports the case of `expect(locator).toBeVisible({ timeout: 1 })`
      // that should succeed when the locator is already visible.
      try {
        const resultOneShot = await this._expectInternal(progress, selector, options, lastIntermediateResult, true);
        if (resultOneShot.matches !== options.isNot)
          return resultOneShot;
      } catch (e) {
        if (this.isNonRetriableError(e))
          throw e;
        // Ignore any other errors from one-shot, we'll handle them during retries.
      }

      // Step 3: auto-retry expect with increasing timeouts. Bounded by the total remaining time.
      const result = await this.retryWithProgressAndTimeouts(progress, [100, 250, 500, 1000], async continuePolling => {
        await this._page.performActionPreChecks(progress);
        const { matches, received } = await this._expectInternal(progress, selector, options, lastIntermediateResult, false);
        if (matches === options.isNot) {
          // Keep waiting in these cases:
          // expect(locator).conditionThatDoesNotMatch
          // expect(locator).not.conditionThatDoesMatch
          return continuePolling;
        }
        return { matches, received };
      });
      fixupMetadataError(result);
      return result;
    } catch (e) {
      // Q: Why not throw upon isNonRetriableError(e) as in other places?
      // A: We want user to receive a friendly message containing the last intermediate result.
      if (js.isJavaScriptErrorInEvaluate(e) || isInvalidSelectorError(e))
        throw e;
      const result: ExpectResult = { matches: options.isNot, log: compressCallLog(progress.metadata.log) };
      if (lastIntermediateResult.isSet)
        result.received = lastIntermediateResult.received;
      if (e instanceof TimeoutError)
        result.timedOut = true;
      fixupMetadataError(result);
      return result;
    }
  }

  private async _expectInternal(progress: Progress, selector: string | undefined, options: FrameExpectParams, lastIntermediateResult: { received?: any, isSet: boolean }, noAbort: boolean) {
    // The first expect check, a.k.a. one-shot, always finishes - even when progress is aborted.
    const race = <T>(p: Promise<T>) => noAbort ? p : progress.race(p);
    const selectorInFrame = selector ? await race(this.selectors.resolveFrameForSelector(selector, { strict: true })) : undefined;

    const { frame, info } = selectorInFrame || { frame: this, info: undefined };
    const world = options.expression === 'to.have.property' ? 'main' : (info?.world ?? 'utility');
    const context = await race(frame._context(world));
    const injected = await race(context.injectedScript());

    const { log, matches, received, missingReceived } = await race(injected.evaluate(async (injected, { info, options, callId }) => {
      const elements = info ? injected.querySelectorAll(info.parsed, document) : [];
      if (callId)
        injected.markTargetElements(new Set(elements), callId);
      const isArray = options.expression === 'to.have.count' || options.expression.endsWith('.array');
      let log = '';
      if (isArray)
        log = `  locator resolved to ${elements.length} element${elements.length === 1 ? '' : 's'}`;
      else if (elements.length > 1)
        throw injected.strictModeViolationError(info!.parsed, elements);
      else if (elements.length)
        log = `  locator resolved to ${injected.previewNode(elements[0])}`;
      return { log, ...await injected.expect(elements[0], options, elements) };
    }, { info, options, callId: progress.metadata.id }));

    if (log)
      progress.log(log);
    // Note: missingReceived avoids `unexpected value "undefined"` when element was not found.
    if (matches === options.isNot) {
      lastIntermediateResult.received = missingReceived ? '<element(s) not found>' : received;
      lastIntermediateResult.isSet = true;
      if (!missingReceived && !Array.isArray(received))
        progress.log(`  unexpected value "${renderUnexpectedValue(options.expression, received)}"`);
    }
    return { matches, received };
  }

  async waitForFunctionExpression<R>(progress: Progress, expression: string, isFunction: boolean | undefined, arg: any, options: { pollingInterval?: number }, world: types.World = 'main'): Promise<js.SmartHandle<R>> {
    if (typeof options.pollingInterval === 'number')
      assert(options.pollingInterval > 0, 'Cannot poll with non-positive interval: ' + options.pollingInterval);
    expression = js.normalizeEvaluationExpression(expression, isFunction);
    return this.retryWithProgressAndTimeouts(progress, [100], async () => {
      const context = world === 'main' ? await progress.race(this._mainContext()) : await progress.race(this._utilityContext());
      const injectedScript = await progress.race(context.injectedScript());
      const handle = await progress.race(injectedScript.evaluateHandle((injected, { expression, isFunction, polling, arg }) => {
        const predicate = (): R => {
          // NOTE: make sure to use `globalThis.eval` instead of `self.eval` due to a bug with sandbox isolation
          // in firefox.
          // See https://bugzilla.mozilla.org/show_bug.cgi?id=1814898
          let result = globalThis.eval(expression);
          if (isFunction === true) {
            result = result(arg);
          } else if (isFunction === false) {
            result = result;
          } else {
            // auto detect.
            if (typeof result === 'function')
              result = result(arg);
          }
          return result;
        };

        let fulfill: (result: R) => void;
        let reject: (error: Error) => void;
        let aborted = false;
        const result = new Promise<R>((f, r) => { fulfill = f; reject = r; });

        const next = () => {
          if (aborted)
            return;
          try {
            const success = predicate();
            if (success) {
              fulfill(success);
              return;
            }
            if (typeof polling !== 'number')
              injected.utils.builtins.requestAnimationFrame(next);
            else
              injected.utils.builtins.setTimeout(next, polling);
          } catch (e) {
            reject(e);
          }
        };

        next();
        return { result, abort: () => aborted = true };
      }, { expression, isFunction, polling: options.pollingInterval, arg }));
      progress.cleanupWhenAborted(() => handle.evaluate(h => h.abort()).finally(() => handle.dispose()));
      const result = await progress.race(handle.evaluateHandle(h => h.result));
      handle.dispose();
      return result;
    });
  }

  async waitForFunctionValueInUtility<R>(progress: Progress, pageFunction: js.Func1<any, R>) {
    const expression = `() => {
      const result = (${pageFunction})();
      if (!result)
        return result;
      return JSON.stringify(result);
    }`;
    const handle = await this.waitForFunctionExpression(progress, expression, true, undefined, {}, 'utility');
    return JSON.parse(handle.rawValue()) as R;
  }

  async title(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluate(() => document.title);
  }

  async rafrafTimeout(progress: Progress, timeout: number): Promise<void> {
    if (timeout === 0)
      return;
    const context = await progress.race(this._utilityContext());
    await Promise.all([
      // wait for double raf
      progress.race(context.evaluate(() => new Promise(x => {
        requestAnimationFrame(() => {
          requestAnimationFrame(x);
        });
      }))),
      progress.wait(timeout),
    ]);
  }

  _onDetached() {
    this._stopNetworkIdleTimer();
    this._detachedScope.close(new Error('Frame was detached'));
    for (const data of this._contextData.values()) {
      if (data.context)
        data.context.contextDestroyed('Frame was detached');
      data.contextPromise.resolve({ destroyedReason: 'Frame was detached' });
    }
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
    this._parentFrame = null;
  }

  private async _callOnElementOnceMatches<T, R>(progress: Progress, selector: string, body: ElementCallback<T, R>, taskData: T, options: types.StrictOptions & { mainWorld?: boolean }, scope?: dom.ElementHandle): Promise<R> {
    const callbackText = body.toString();
    progress.log(`waiting for ${this._asLocator(selector)}`);
    const promise = this.retryWithProgressAndTimeouts(progress, [0, 20, 50, 100, 100, 500], async continuePolling => {
      const resolved = await progress.race(this.selectors.resolveInjectedForSelector(selector, options, scope));
      if (!resolved)
        return continuePolling;
      const { log, success, value } = await progress.race(resolved.injected.evaluate((injected, { info, callbackText, taskData, callId, root }) => {
        const callback = injected.eval(callbackText) as ElementCallback<T, R>;
        const element = injected.querySelector(info.parsed, root || document, info.strict);
        if (!element)
          return { success: false };
        const log = `  locator resolved to ${injected.previewNode(element)}`;
        if (callId)
          injected.markTargetElements(new Set([element]), callId);
        return { log, success: true, value: callback(injected, element, taskData as T) };
      }, { info: resolved.info, callbackText, taskData, callId: progress.metadata.id, root: resolved.frame === this ? scope : undefined }));
      if (log)
        progress.log(log);
      if (!success)
        return continuePolling;
      return value!;
    });
    return scope ? scope._context._raceAgainstContextDestroyed(promise) : promise;
  }

  private _setContext(world: types.World, context: dom.FrameExecutionContext | null) {
    const data = this._contextData.get(world)!;
    data.context = context;
    if (context)
      data.contextPromise.resolve(context);
    else
      data.contextPromise = new ManualPromise();
  }

  _contextCreated(world: types.World, context: dom.FrameExecutionContext) {
    const data = this._contextData.get(world)!;
    // In case of multiple sessions to the same target, there's a race between
    // connections so we might end up creating multiple isolated worlds.
    // We can use either.
    if (data.context) {
      data.context.contextDestroyed('Execution context was destroyed, most likely because of a navigation');
      this._setContext(world, null);
    }
    this._setContext(world, context);
  }

  _contextDestroyed(context: dom.FrameExecutionContext) {
    // Sometimes we get this after detach, in which case we should not reset
    // our already destroyed contexts to something that will never resolve.
    if (this._detachedScope.isClosed())
      return;
    context.contextDestroyed('Execution context was destroyed, most likely because of a navigation');
    for (const [world, data] of this._contextData) {
      if (data.context === context)
        this._setContext(world, null);
    }
  }

  _startNetworkIdleTimer() {
    assert(!this._networkIdleTimer);
    // We should not start a timer and report networkidle in detached frames.
    // This happens at least in Firefox for child frames, where we may get requestFinished
    // after the frame was detached - probably a race in the Firefox itself.
    if (this._firedLifecycleEvents.has('networkidle') || this._detachedScope.isClosed())
      return;
    this._networkIdleTimer = setTimeout(() => {
      this._firedNetworkIdleSelf = true;
      this._page.mainFrame()._recalculateNetworkIdle();
    }, 500);
  }

  _stopNetworkIdleTimer() {
    if (this._networkIdleTimer)
      clearTimeout(this._networkIdleTimer);
    this._networkIdleTimer = undefined;
    this._firedNetworkIdleSelf = false;
  }

  async extendInjectedScript(source: string, arg?: any): Promise<js.JSHandle> {
    const context = await this._context('main');
    const injectedScriptHandle = await context.injectedScript();
    return injectedScriptHandle.evaluateHandle((injectedScript, { source, arg }) => {
      return injectedScript.extend(source, arg);
    }, { source, arg });
  }

  private _asLocator(selector: string) {
    return asLocator(this._page.browserContext._browser.sdkLanguage(), selector);
  }
}

class SignalBarrier {
  private _progress: Progress;
  private _protectCount = 0;
  private _promise = new ManualPromise<void>();

  constructor(progress: Progress) {
    this._progress = progress;
    this.retain();
  }

  waitFor(): PromiseLike<void> {
    this.release();
    return this._progress.race(this._promise);
  }

  addFrameNavigation(frame: Frame) {
    // Auto-wait top-level navigations only.
    if (frame.parentFrame())
      return;
    this.retain();
    const waiter = helper.waitForEvent(this._progress, frame, Frame.Events.InternalNavigation, (e: NavigationEvent) => {
      if (!e.isPublic)
        return false;
      if (!e.error && this._progress)
        this._progress.log(`  navigated to "${frame._url}"`);
      return true;
    });
    LongStandingScope.raceMultiple([
      frame._page.openScope,
      frame._detachedScope,
    ], waiter.promise).catch(() => {}).finally(() => {
      waiter.dispose();
      this.release();
    });
  }

  retain() {
    ++this._protectCount;
  }

  release() {
    --this._protectCount;
    if (!this._protectCount)
      this._promise.resolve();
  }
}

function verifyLifecycle(name: string, waitUntil: types.LifecycleEvent): types.LifecycleEvent {
  if (waitUntil as unknown === 'networkidle0')
    waitUntil = 'networkidle';
  if (!types.kLifecycleEvents.has(waitUntil))
    throw new Error(`${name}: expected one of (load|domcontentloaded|networkidle|commit)`);
  return waitUntil;
}

function renderUnexpectedValue(expression: string, received: any): string {
  if (expression === 'to.match.aria')
    return received ? received.raw : received;
  return received;
}
