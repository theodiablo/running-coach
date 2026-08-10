import UIKit
import Capacitor

// Capacitor 8 does not auto-register app-local Swift plugins (only SPM/pod
// packages are discovered), so the bridge view controller registers them by
// hand. Main.storyboard's view controller custom class points here instead of
// at CAPBridgeViewController directly.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthKitBridgePlugin())
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(AudioCuePlugin())
    }
}
