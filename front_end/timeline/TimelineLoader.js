// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @implements {Common.OutputStream}
 * @unrestricted
 */
export default class TimelineLoader {
  /**
   * @param {!Client} client
   */
  constructor(client) {
    this._client = client;

    this._backingStorage = new Bindings.TempFileBackingStorage();
    this._tracingModel = new SDK.TracingModel(this._backingStorage);

    /** @type {?function()} */
    this._canceledCallback = null;
    this._state = State.Initial;
    this._buffer = '';
    this._firstRawChunk = true;
    this._firstChunk = true;
    this._loadedBytes = 0;
    /** @type {number} */
    this._totalSize;
    this._jsonTokenizer = new TextUtils.BalancedJSONTokenizer(this._writeBalancedJSON.bind(this), true);
  }

  /**
   * @param {!File} file
   * @param {!Client} client
   * @return {!TimelineLoader}
   */
  static loadFromFile(file, client) {
    const loader = new TimelineLoader(client);
    const fileReader = new Bindings.ChunkedFileReader(file, TransferChunkLengthBytes);
    loader._canceledCallback = fileReader.cancel.bind(fileReader);
    loader._totalSize = file.size;
    fileReader.read(loader).then(success => {
      if (!success) {
        loader._reportErrorAndCancelLoading(fileReader.error().message);
      }
    });
    return loader;
  }

  /**
   * @param {!Array.<!SDK.TracingManager.EventPayload>} events
   * @param {!Client} client
   * @return {!TimelineLoader}
   */
  static loadFromEvents(events, client) {
    const loader = new TimelineLoader(client);

    setTimeout(async () => {
      const eventsPerChunk = 5000;
      client.loadingStarted();
      for (let i = 0; i < events.length; i += eventsPerChunk) {
        const chunk = events.slice(i, i + eventsPerChunk);
        loader._tracingModel.addEvents(chunk);
        client.loadingProgress((i + chunk.length) / events.length);
        await new Promise(r => setTimeout(r));  // Yield event loop to paint.
      }
      loader.close();
    });

    return loader;
  }

  /**
   * @param {string} url
   * @param {!Client} client
   * @return {!TimelineLoader}
   */
  static loadFromURL(url, client) {
    const loader = new TimelineLoader(client);
    Host.ResourceLoader.loadAsStream(url, null, loader);
    return loader;
  }

  cancel() {
    this._tracingModel = null;
    this._backingStorage.reset();
    this._client.loadingComplete(null);
    this._client = null;
    if (this._canceledCallback) {
      this._canceledCallback();
    }
  }

  /**
   * @override
   * @param {string} chunk
   * @return {!Promise}
   */
  write(chunk) {
    if (!this._client) {
      return Promise.resolve();
    }
    this._loadedBytes += chunk.length;
    if (this._firstRawChunk) {
      this._client.loadingStarted();
    } else {
      this._client.loadingProgress(this._totalSize ? this._loadedBytes / this._totalSize : undefined);
    }
    this._firstRawChunk = false;

    if (this._state === State.Initial) {
      if (chunk.startsWith('{"nodes":[')) {
        this._state = State.LoadingCPUProfileFormat;
      } else if (chunk[0] === '{') {
        this._state = State.LookingForEvents;
      } else if (chunk[0] === '[') {
        this._state = State.ReadingEvents;
      } else {
        this._reportErrorAndCancelLoading(Common.UIString('Malformed timeline data: Unknown JSON format'));
        return Promise.resolve();
      }
    }

    if (this._state === State.LoadingCPUProfileFormat) {
      this._buffer += chunk;
      return Promise.resolve();
    }

    if (this._state === State.LookingForEvents) {
      const objectName = '"traceEvents":';
      const startPos = this._buffer.length - objectName.length;
      this._buffer += chunk;
      const pos = this._buffer.indexOf(objectName, startPos);
      if (pos === -1) {
        return Promise.resolve();
      }
      chunk = this._buffer.slice(pos + objectName.length);
      this._state = State.ReadingEvents;
    }

    if (this._state !== State.ReadingEvents) {
      return Promise.resolve();
    }
    if (this._jsonTokenizer.write(chunk)) {
      return Promise.resolve();
    }
    this._state = State.SkippingTail;
    if (this._firstChunk) {
      this._reportErrorAndCancelLoading(Common.UIString('Malformed timeline input, wrong JSON brackets balance'));
    }
    return Promise.resolve();
  }

  /**
   * @param {string} data
   */
  _writeBalancedJSON(data) {
    let json = data + ']';

    if (!this._firstChunk) {
      const commaIndex = json.indexOf(',');
      if (commaIndex !== -1) {
        json = json.slice(commaIndex + 1);
      }
      json = '[' + json;
    }

    let items;
    try {
      items = /** @type {!Array.<!SDK.TracingManager.EventPayload>} */ (JSON.parse(json));
    } catch (e) {
      this._reportErrorAndCancelLoading(Common.UIString('Malformed timeline data: %s', e.toString()));
      return;
    }

    if (this._firstChunk) {
      this._firstChunk = false;
      if (this._looksLikeAppVersion(items[0])) {
        this._reportErrorAndCancelLoading(Common.UIString('Legacy Timeline format is not supported.'));
        return;
      }
    }

    try {
      this._tracingModel.addEvents(items);
    } catch (e) {
      this._reportErrorAndCancelLoading(Common.UIString('Malformed timeline data: %s', e.toString()));
    }
  }

  /**
   * @param {string=} message
   */
  _reportErrorAndCancelLoading(message) {
    if (message) {
      Common.console.error(message);
    }
    this.cancel();
  }

  /**
   * @param {*} item
   * @return {boolean}
   */
  _looksLikeAppVersion(item) {
    return typeof item === 'string' && item.indexOf('Chrome') !== -1;
  }

  /**
   * @override
   */
  async close() {
    if (!this._client) {
      return;
    }
    this._client.processingStarted();
    setTimeout(() => this._finalizeTrace(), 0);
  }

  _finalizeTrace() {
    if (this._state === State.LoadingCPUProfileFormat) {
      this._parseCPUProfileFormat(this._buffer);
      this._buffer = '';
    }
    this._tracingModel.tracingComplete();
    this._client.loadingComplete(this._tracingModel);
  }

  /**
   * @param {string} text
   */
  _parseCPUProfileFormat(text) {
    let traceEvents;
    try {
      const profile = JSON.parse(text);
      traceEvents = TimelineModel.TimelineJSProfileProcessor.buildTraceProfileFromCpuProfile(
          profile, /* tid */ 1, /* injectPageEvent */ true);
    } catch (e) {
      this._reportErrorAndCancelLoading(Common.UIString('Malformed CPU profile format'));
      return;
    }
    this._tracingModel.addEvents(traceEvents);
  }
}

export const TransferChunkLengthBytes = 5000000;

/**
 * @interface
 */
export class Client {
  loadingStarted() {
  }

  /**
   * @param {number=} progress
   */
  loadingProgress(progress) {
  }

  processingStarted() {
  }

  /**
   * @param {?SDK.TracingModel} tracingModel
   */
  loadingComplete(tracingModel) {
  }
}

/**
 * @enum {symbol}
 */
export const State = {
  Initial: Symbol('Initial'),
  LookingForEvents: Symbol('LookingForEvents'),
  ReadingEvents: Symbol('ReadingEvents'),
  SkippingTail: Symbol('SkippingTail'),
  LoadingCPUProfileFormat: Symbol('LoadingCPUProfileFormat')
};

/* Legacy exported object */
self.Timeline = self.Timeline || {};

/* Legacy exported object */
Timeline = Timeline || {};

/** @constructor */
Timeline.TimelineLoader = TimelineLoader;

Timeline.TimelineLoader.TransferChunkLengthBytes = TransferChunkLengthBytes;

/** @interface */
Timeline.TimelineLoader.Client = Client;

/** @enum {symbol} */
Timeline.TimelineLoader.State = State;
