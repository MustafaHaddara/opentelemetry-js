/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PerformanceEntries,
  PerformanceResourceTimingInfo,
  PropagateTraceHeaderCorsUrls,
} from './types';
import { PerformanceTimingNames as PTN } from './enums/PerformanceTimingNames';
import * as api from '@opentelemetry/api';
import {
  hrTimeToNanoseconds,
  timeInputToHrTime,
  urlMatches,
} from '@opentelemetry/core';
import {
  SEMATTRS_HTTP_RESPONSE_CONTENT_LENGTH,
  SEMATTRS_HTTP_RESPONSE_CONTENT_LENGTH_UNCOMPRESSED,
} from '@opentelemetry/semantic-conventions';

const DIAG_LOGGER = api.diag.createComponentLogger({
  namespace: '@opentelemetry/opentelemetry-sdk-trace-web/utils',
});

// Used to normalize relative URLs
let urlNormalizingAnchor: HTMLAnchorElement | undefined;
function getUrlNormalizingAnchor(): HTMLAnchorElement {
  if (!urlNormalizingAnchor) {
    urlNormalizingAnchor = document.createElement('a');
  }

  return urlNormalizingAnchor;
}

/**
 * Helper function to be able to use enum as typed key in type and in interface when using forEach
 * @param obj
 * @param key
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hasKey<O extends object>(
  obj: O,
  key: keyof any
): key is keyof O {
  return key in obj;
}

/**
 * Helper function for starting an event on span based on {@link PerformanceEntries}
 * @param span
 * @param performanceName name of performance entry for time start
 * @param entries
 * @param refPerfName name of performance entry to use for reference
 */
export function addSpanNetworkEvent(
  span: api.Span,
  performanceName: string,
  entries: PerformanceEntries,
  refPerfName?: string
): api.Span | undefined {
  let perfTime = undefined;
  let refTime = undefined;
  if (
    hasKey(entries, performanceName) &&
    typeof entries[performanceName] === 'number'
  ) {
    perfTime = entries[performanceName];
  }
  const refName = refPerfName || PTN.FETCH_START;
  // Use a reference time which is the earliest possible value so that the performance timings that are earlier should not be added
  // using FETCH START time in case no reference is provided
  if (hasKey(entries, refName) && typeof entries[refName] === 'number') {
    refTime = entries[refName];
  }
  if (perfTime !== undefined && refTime !== undefined && perfTime >= refTime) {
    span.addEvent(performanceName, perfTime);
    return span;
  }
  return undefined;
}

/**
 * Helper function for adding network events
 * @param span
 * @param resource
 */
export function addSpanNetworkEvents(
  span: api.Span,
  resource: PerformanceEntries
): void {
  addSpanNetworkEvent(span, PTN.FETCH_START, resource);
  addSpanNetworkEvent(span, PTN.DOMAIN_LOOKUP_START, resource);
  addSpanNetworkEvent(span, PTN.DOMAIN_LOOKUP_END, resource);
  addSpanNetworkEvent(span, PTN.CONNECT_START, resource);
  if (
    hasKey(resource as PerformanceResourceTiming, 'name') &&
    (resource as PerformanceResourceTiming)['name'].startsWith('https:')
  ) {
    addSpanNetworkEvent(span, PTN.SECURE_CONNECTION_START, resource);
  }
  addSpanNetworkEvent(span, PTN.CONNECT_END, resource);
  addSpanNetworkEvent(span, PTN.REQUEST_START, resource);
  addSpanNetworkEvent(span, PTN.RESPONSE_START, resource);
  addSpanNetworkEvent(span, PTN.RESPONSE_END, resource);
  const encodedLength = resource[PTN.ENCODED_BODY_SIZE];
  if (encodedLength !== undefined) {
    span.setAttribute(SEMATTRS_HTTP_RESPONSE_CONTENT_LENGTH, encodedLength);
  }
  const decodedLength = resource[PTN.DECODED_BODY_SIZE];
  // Spec: Not set if transport encoding not used (in which case encoded and decoded sizes match)
  if (decodedLength !== undefined && encodedLength !== decodedLength) {
    span.setAttribute(
      SEMATTRS_HTTP_RESPONSE_CONTENT_LENGTH_UNCOMPRESSED,
      decodedLength
    );
  }
}

function _getBodyNonDestructively(body: ReadableStream) {
  // can't read a ReadableStream without destroying it
  // on most platforms, we CAN tee the body stream, which lets us split it,
  // but that still locks the original stream, so we end up needing to return one of the forks.
  //
  // some (older) platforms don't expose the tee method and in that scenario, we're out of luck;
  //   there's no way to read the stream without consuming it.
  if (!body.tee) {
    return {
      body,
      length: Promise.resolve(null),
    };
  }

  const [bodyToReturn, bodyToConsume] = body.tee();

  const lengthPromise = async () => {
    let length = 0;
    const reader = bodyToConsume.getReader();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const contents = await reader.read();
      if (contents.value) {
        length += contents.value.length;
      }
      if (contents.done) {
        break;
      }
    }
    return length;
  };

  return {
    body: bodyToReturn,
    length: lengthPromise(),
  };
}

/**
 * Helper function to determine payload content length for fetch requests
 *
 * The fetch API is kinda messy: there are a couple of ways the body can be passed in.
 *
 * In all cases, the body param can be some variation of ReadableStream,
 * and ReadableStreams can only be read once! We want to avoid consuming the body here,
 * because that would mean that the body never gets sent with the actual fetch request.
 *
 * Either the first arg is a Request object, which can be cloned
 *   so we can clone that object and read the body of the clone
 *   without disturbing the original argument
 *   However, reading the body here can only be done async; the body() method returns a promise
 *   this means this entire function has to return a promise
 *
 * OR the first arg is a url/string
 *   in which case the second arg has type RequestInit
 *   RequestInit is NOT cloneable, but RequestInit.body is writable
 *   so we can chain it into ReadableStream.pipeThrough()
 *
 *   ReadableStream.pipeThrough() lets us process a stream and returns a new stream
 *   So we can measure the body length as it passes through the pie, but need to attach
 *   the new stream to the original request
 *   so that the browser still has access to the body.
 *
 * @param body
 * @returns promise that resolves to the content length of the body
 */
export function getFetchBodyLength(...args: Parameters<typeof fetch>) {
  if (args[0] instanceof URL || typeof args[0] === 'string') {
    const requestInit = args[1];
    if (!requestInit?.body) {
      return Promise.resolve();
    }
    if (requestInit.body instanceof ReadableStream) {
      const { body, length } = _getBodyNonDestructively(requestInit.body);
      requestInit.body = body;

      return length;
    } else {
      return Promise.resolve(getXHRBodyLength(requestInit.body));
    }
  } else {
    const info = args[0];
    if (!info?.body) {
      return Promise.resolve();
    }

    return info
      .clone()
      .text()
      .then(t => t.length);
  }
}

/**
 * Helper function to determine payload content length for XHR requests
 * @param body
 * @returns content length
 */
export function getXHRBodyLength(
  body: Document | XMLHttpRequestBodyInit
): number {
  if (typeof Document !== 'undefined' && body instanceof Document) {
    return new XMLSerializer().serializeToString(document).length;
  }
  // XMLHttpRequestBodyInit expands to the following:
  if (body instanceof Blob) {
    return body.size;
  }

  // ArrayBuffer | ArrayBufferView
  if ((body as any).byteLength !== undefined) {
    return (body as any).byteLength as number;
  }

  if (body instanceof FormData) {
    // typescript doesn't like it when we pass FormData into URLSearchParams
    // even though this is actually totally valid
    return new URLSearchParams(body as any).toString().length;
  }

  if (body instanceof URLSearchParams) {
    return body.toString().length;
  }

  if (typeof body === 'string') {
    return body.length;
  }

  DIAG_LOGGER.warn('unknown body type');
  return 0;
}

/**
 * sort resources by startTime
 * @param filteredResources
 */
export function sortResources(
  filteredResources: PerformanceResourceTiming[]
): PerformanceResourceTiming[] {
  return filteredResources.slice().sort((a, b) => {
    const valueA = a[PTN.FETCH_START];
    const valueB = b[PTN.FETCH_START];
    if (valueA > valueB) {
      return 1;
    } else if (valueA < valueB) {
      return -1;
    }
    return 0;
  });
}

/** Returns the origin if present (if in browser context). */
function getOrigin(): string | undefined {
  return typeof location !== 'undefined' ? location.origin : undefined;
}

/**
 * Get closest performance resource ignoring the resources that have been
 * already used.
 * @param spanUrl
 * @param startTimeHR
 * @param endTimeHR
 * @param resources
 * @param ignoredResources
 * @param initiatorType
 */
export function getResource(
  spanUrl: string,
  startTimeHR: api.HrTime,
  endTimeHR: api.HrTime,
  resources: PerformanceResourceTiming[],
  ignoredResources: WeakSet<PerformanceResourceTiming> = new WeakSet<PerformanceResourceTiming>(),
  initiatorType?: string
): PerformanceResourceTimingInfo {
  // de-relativize the URL before usage (does no harm to absolute URLs)
  const parsedSpanUrl = parseUrl(spanUrl);
  spanUrl = parsedSpanUrl.toString();

  const filteredResources = filterResourcesForSpan(
    spanUrl,
    startTimeHR,
    endTimeHR,
    resources,
    ignoredResources,
    initiatorType
  );

  if (filteredResources.length === 0) {
    return {
      mainRequest: undefined,
    };
  }
  if (filteredResources.length === 1) {
    return {
      mainRequest: filteredResources[0],
    };
  }
  const sorted = sortResources(filteredResources);

  if (parsedSpanUrl.origin !== getOrigin() && sorted.length > 1) {
    let corsPreFlightRequest: PerformanceResourceTiming | undefined = sorted[0];
    let mainRequest: PerformanceResourceTiming = findMainRequest(
      sorted,
      corsPreFlightRequest[PTN.RESPONSE_END],
      endTimeHR
    );

    const responseEnd = corsPreFlightRequest[PTN.RESPONSE_END];
    const fetchStart = mainRequest[PTN.FETCH_START];

    // no corsPreFlightRequest
    if (fetchStart < responseEnd) {
      mainRequest = corsPreFlightRequest;
      corsPreFlightRequest = undefined;
    }

    return {
      corsPreFlightRequest,
      mainRequest,
    };
  } else {
    return {
      mainRequest: filteredResources[0],
    };
  }
}

/**
 * Will find the main request skipping the cors pre flight requests
 * @param resources
 * @param corsPreFlightRequestEndTime
 * @param spanEndTimeHR
 */
function findMainRequest(
  resources: PerformanceResourceTiming[],
  corsPreFlightRequestEndTime: number,
  spanEndTimeHR: api.HrTime
): PerformanceResourceTiming {
  const spanEndTime = hrTimeToNanoseconds(spanEndTimeHR);
  const minTime = hrTimeToNanoseconds(
    timeInputToHrTime(corsPreFlightRequestEndTime)
  );

  let mainRequest: PerformanceResourceTiming = resources[1];
  let bestGap;

  const length = resources.length;
  for (let i = 1; i < length; i++) {
    const resource = resources[i];
    const resourceStartTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.FETCH_START])
    );

    const resourceEndTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.RESPONSE_END])
    );

    const currentGap = spanEndTime - resourceEndTime;

    if (resourceStartTime >= minTime && (!bestGap || currentGap < bestGap)) {
      bestGap = currentGap;
      mainRequest = resource;
    }
  }
  return mainRequest;
}

/**
 * Filter all resources that has started and finished according to span start time and end time.
 *     It will return the closest resource to a start time
 * @param spanUrl
 * @param startTimeHR
 * @param endTimeHR
 * @param resources
 * @param ignoredResources
 */
function filterResourcesForSpan(
  spanUrl: string,
  startTimeHR: api.HrTime,
  endTimeHR: api.HrTime,
  resources: PerformanceResourceTiming[],
  ignoredResources: WeakSet<PerformanceResourceTiming>,
  initiatorType?: string
) {
  const startTime = hrTimeToNanoseconds(startTimeHR);
  const endTime = hrTimeToNanoseconds(endTimeHR);
  let filteredResources = resources.filter(resource => {
    const resourceStartTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.FETCH_START])
    );
    const resourceEndTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.RESPONSE_END])
    );

    return (
      resource.initiatorType.toLowerCase() ===
        (initiatorType || 'xmlhttprequest') &&
      resource.name === spanUrl &&
      resourceStartTime >= startTime &&
      resourceEndTime <= endTime
    );
  });

  if (filteredResources.length > 0) {
    filteredResources = filteredResources.filter(resource => {
      return !ignoredResources.has(resource);
    });
  }

  return filteredResources;
}

/**
 * The URLLike interface represents an URL and HTMLAnchorElement compatible fields.
 */
export interface URLLike {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  username: string;
}

/**
 * Parses url using URL constructor or fallback to anchor element.
 * @param url
 */
export function parseUrl(url: string): URLLike {
  if (typeof URL === 'function') {
    return new URL(
      url,
      typeof document !== 'undefined'
        ? document.baseURI
        : typeof location !== 'undefined' // Some JS runtimes (e.g. Deno) don't define this
        ? location.href
        : undefined
    );
  }
  const element = getUrlNormalizingAnchor();
  element.href = url;
  return element;
}

/**
 * Parses url using URL constructor or fallback to anchor element and serialize
 * it to a string.
 *
 * Performs the steps described in https://html.spec.whatwg.org/multipage/urls-and-fetching.html#parse-a-url
 *
 * @param url
 */
export function normalizeUrl(url: string): string {
  const urlLike = parseUrl(url);
  return urlLike.href;
}

/**
 * Get element XPath
 * @param target - target element
 * @param optimised - when id attribute of element is present the xpath can be
 * simplified to contain id
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
export function getElementXPath(target: any, optimised?: boolean): string {
  if (target.nodeType === Node.DOCUMENT_NODE) {
    return '/';
  }
  const targetValue = getNodeValue(target, optimised);
  if (optimised && targetValue.indexOf('@id') > 0) {
    return targetValue;
  }
  let xpath = '';
  if (target.parentNode) {
    xpath += getElementXPath(target.parentNode, false);
  }
  xpath += targetValue;

  return xpath;
}

/**
 * get node index within the siblings
 * @param target
 */
function getNodeIndex(target: HTMLElement): number {
  if (!target.parentNode) {
    return 0;
  }
  const allowedTypes = [target.nodeType];
  if (target.nodeType === Node.CDATA_SECTION_NODE) {
    allowedTypes.push(Node.TEXT_NODE);
  }
  let elements = Array.from(target.parentNode.childNodes);
  elements = elements.filter((element: Node) => {
    const localName = (element as HTMLElement).localName;
    return (
      allowedTypes.indexOf(element.nodeType) >= 0 &&
      localName === target.localName
    );
  });
  if (elements.length >= 1) {
    return elements.indexOf(target) + 1; // xpath starts from 1
  }
  // if there are no other similar child xpath doesn't need index
  return 0;
}

/**
 * get node value for xpath
 * @param target
 * @param optimised
 */
function getNodeValue(target: HTMLElement, optimised?: boolean): string {
  const nodeType = target.nodeType;
  const index = getNodeIndex(target);
  let nodeValue = '';
  if (nodeType === Node.ELEMENT_NODE) {
    const id = target.getAttribute('id');
    if (optimised && id) {
      return `//*[@id="${id}"]`;
    }
    nodeValue = target.localName;
  } else if (
    nodeType === Node.TEXT_NODE ||
    nodeType === Node.CDATA_SECTION_NODE
  ) {
    nodeValue = 'text()';
  } else if (nodeType === Node.COMMENT_NODE) {
    nodeValue = 'comment()';
  } else {
    return '';
  }
  // if index is 1 it can be omitted in xpath
  if (nodeValue && index > 1) {
    return `/${nodeValue}[${index}]`;
  }
  return `/${nodeValue}`;
}

/**
 * Checks if trace headers should be propagated
 * @param spanUrl
 * @private
 */
export function shouldPropagateTraceHeaders(
  spanUrl: string,
  propagateTraceHeaderCorsUrls?: PropagateTraceHeaderCorsUrls
): boolean {
  let propagateTraceHeaderUrls = propagateTraceHeaderCorsUrls || [];
  if (
    typeof propagateTraceHeaderUrls === 'string' ||
    propagateTraceHeaderUrls instanceof RegExp
  ) {
    propagateTraceHeaderUrls = [propagateTraceHeaderUrls];
  }
  const parsedSpanUrl = parseUrl(spanUrl);

  if (parsedSpanUrl.origin === getOrigin()) {
    return true;
  } else {
    return propagateTraceHeaderUrls.some(propagateTraceHeaderUrl =>
      urlMatches(spanUrl, propagateTraceHeaderUrl)
    );
  }
}
