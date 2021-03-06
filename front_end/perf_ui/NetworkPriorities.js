// Copyright 2017 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @param {!Protocol.Network.ResourcePriority} priority
 * @return {string}
 */
export function uiLabelForNetworkPriority(priority) {
  return priorityUILabelMap().get(priority) || '';
}

/**
 * @param {string} priorityLabel
 * @return {string}
 */
export function uiLabelToNetworkPriority(priorityLabel) {
  if (!PerfUI._uiLabelToPriorityMapInstance) {
    /** @type {!Map<string, !Protocol.Network.ResourcePriority>} */
    PerfUI._uiLabelToPriorityMapInstance = new Map();
    priorityUILabelMap().forEach((value, key) => PerfUI._uiLabelToPriorityMapInstance.set(value, key));
  }
  return PerfUI._uiLabelToPriorityMapInstance.get(priorityLabel) || '';
}

/** @type {?Map<!Protocol.Network.ResourcePriority, string>} */
let _priorityUILabelMapInstance = null;

/**
 * @return {!Map<!Protocol.Network.ResourcePriority, string>}
 */
export function priorityUILabelMap() {
  if (_priorityUILabelMapInstance) {
    return _priorityUILabelMapInstance;
  }

  /** @type {!Map<!Protocol.Network.ResourcePriority, string>} */
  const map = new Map();
  map.set(Protocol.Network.ResourcePriority.VeryLow, Common.UIString('Lowest'));
  map.set(Protocol.Network.ResourcePriority.Low, Common.UIString('Low'));
  map.set(Protocol.Network.ResourcePriority.Medium, Common.UIString('Medium'));
  map.set(Protocol.Network.ResourcePriority.High, Common.UIString('High'));
  map.set(Protocol.Network.ResourcePriority.VeryHigh, Common.UIString('Highest'));
  _priorityUILabelMapInstance = map;
  return map;
}

/**
 * @param {!Protocol.Network.ResourcePriority} priority
 * @return {number}
 */
export function networkPriorityWeight(priority) {
  if (!PerfUI._networkPriorityWeights) {
    /** @type {!Map<!Protocol.Network.ResourcePriority, number>} */
    const priorityMap = new Map();
    priorityMap.set(Protocol.Network.ResourcePriority.VeryLow, 1);
    priorityMap.set(Protocol.Network.ResourcePriority.Low, 2);
    priorityMap.set(Protocol.Network.ResourcePriority.Medium, 3);
    priorityMap.set(Protocol.Network.ResourcePriority.High, 4);
    priorityMap.set(Protocol.Network.ResourcePriority.VeryHigh, 5);
    PerfUI._networkPriorityWeights = priorityMap;
  }
  return PerfUI._networkPriorityWeights.get(priority) || 0;
}
