import Foundation
import Capacitor
import StoreKit
import UIKit

// The App Store's own review prompt and product sheet (docs/release.md, "Store
// prompts"). iOS has no in-app update API: the closest native thing is the
// store page shown in-app, or TestFlight for a beta build.
@objc(StoreBridgePlugin)
public class StoreBridgePlugin: CAPPlugin, CAPBridgedPlugin, SKStoreProductViewControllerDelegate {
    public let identifier = "StoreBridgePlugin"
    public let jsName = "StoreBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openStorePage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInstallInfo", returnType: CAPPluginReturnPromise),
    ]

    private var isTestFlight: Bool {
        Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    }

    // TestFlight and Xcode builds can't post an App Store review. A store install
    // also gets its listing (id, live version), found by bundle id once public.
    @objc func getInstallInfo(_ call: CAPPluginCall) {
        if isTestFlight {
            call.resolve(["fromStore": false])
            return
        }
        lookupListing { id, version in
            var ret: [String: Any] = ["fromStore": true]
            if let id = id { ret["appId"] = id }
            if let version = version { ret["storeVersion"] = version }
            call.resolve(ret)
        }
    }

    // iOS decides (3 a year, never in TestFlight) whether this shows, and never says.
    @objc func requestReview(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let scene = self?.bridge?.viewController?.view.window?.windowScene else {
                call.reject("no window scene")
                return
            }
            if #available(iOS 16.0, *) {
                AppStore.requestReview(in: scene)
            } else {
                SKStoreReviewController.requestReview(in: scene)
            }
            call.resolve()
        }
    }

    // TestFlight builds update through TestFlight; store builds get the in-app
    // product sheet. The id is looked up by bundle id when JS doesn't pass one.
    // `review: true` opens the App Store's write-a-review page instead.
    @objc func openStorePage(_ call: CAPPluginCall) {
        let review = call.getBool("review") ?? false
        if !review && isTestFlight {
            open("itms-beta://", call)
            return
        }
        let show: (String) -> Void = { [weak self] id in
            if review {
                self?.open("itms-apps://itunes.apple.com/app/id\(id)?action=write-review", call)
            } else {
                self?.present(id: id, call)
            }
        }
        let given = call.getString("appId") ?? ""
        if !given.isEmpty {
            show(given)
            return
        }
        lookupListing { id, _ in
            if let id = id { show(id) } else { call.reject("not listed") }
        }
    }

    public func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
        viewController.dismiss(animated: true)
    }

    private func present(id: String, _ call: CAPPluginCall) {
        guard let num = Int(id) else {
            call.reject("bad id")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController else {
                call.reject("no view controller")
                return
            }
            let store = SKStoreProductViewController()
            store.delegate = self
            store.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: NSNumber(value: num)], completionBlock: nil)
            host.present(store, animated: true)
            call.resolve()
        }
    }

    private func lookupListing(_ done: @escaping (String?, String?) -> Void) {
        guard let bundleId = Bundle.main.bundleIdentifier,
              var comps = URLComponents(string: "https://itunes.apple.com/lookup") else {
            done(nil, nil)
            return
        }
        var items = [URLQueryItem(name: "bundleId", value: bundleId)]
        if let region = Locale.current.regionCode {
            items.append(URLQueryItem(name: "country", value: region.lowercased()))
        }
        comps.queryItems = items
        guard let url = comps.url else {
            done(nil, nil)
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            var id: String?
            var version: String?
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let first = (json["results"] as? [[String: Any]])?.first {
                id = (first["trackId"] as? NSNumber)?.stringValue
                version = first["version"] as? String
            }
            done(id, version)
        }.resume()
    }

    private func open(_ link: String, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: link) else {
                call.reject("bad url")
                return
            }
            UIApplication.shared.open(url) { ok in
                if ok { call.resolve() } else { call.reject("could not open") }
            }
        }
    }
}
