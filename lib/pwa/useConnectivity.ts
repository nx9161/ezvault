// SPDX-License-Identifier: MIT
// React binding for the connectivity state machine (Wave E).

"use client";

import { useSyncExternalStore } from "react";
import {
  getConnectivityState,
  subscribeConnectivity,
  type ConnectivityState,
} from "./connectivity";

export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(
    subscribeConnectivity,
    getConnectivityState,
    getConnectivityState,
  );
}

/** True while the E-SEC-19 offline state is active. */
export function useOffline(): boolean {
  return useConnectivity().offline;
}
