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
    ]

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
    @objc func openStorePage(_ call: CAPPluginCall) {
        if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" {
            open("itms-beta://", call)
            return
        }
        let given = call.getString("appId") ?? ""
        if !given.isEmpty {
            present(id: given, call)
            return
        }
        lookupAppId { [weak self] id in
            guard let self = self else { return }
            if let id = id { self.present(id: id, call) } else { call.reject("not listed") }
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

    private func lookupAppId(_ done: @escaping (String?) -> Void) {
        guard let bundleId = Bundle.main.bundleIdentifier,
              var comps = URLComponents(string: "https://itunes.apple.com/lookup") else {
            done(nil)
            return
        }
        var items = [URLQueryItem(name: "bundleId", value: bundleId)]
        if let region = Locale.current.regionCode {
            items.append(URLQueryItem(name: "country", value: region.lowercased()))
        }
        comps.queryItems = items
        guard let url = comps.url else {
            done(nil)
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            var id: String?
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let results = json["results"] as? [[String: Any]],
               let track = results.first?["trackId"] as? NSNumber {
                id = track.stringValue
            }
            done(id)
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
