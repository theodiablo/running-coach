import { isNative } from "../native";
import { webSource } from "./web";
import { nativeSource } from "./native";

// The single geolocation source useRunTracker talks to. The native source is selected only in
// the Capacitor shell; browsers get the web source. native.js statically imports its plugins
// (a dynamic import can fail in the WebView) but never uses them on the web.
export const geoSource = isNative ? nativeSource : webSource;
