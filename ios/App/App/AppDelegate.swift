import UIKit
import Capacitor

// URL opens and universal links arrive through SceneDelegate: with a scene manifest, UIKit never calls the app-delegate versions.
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }
}
