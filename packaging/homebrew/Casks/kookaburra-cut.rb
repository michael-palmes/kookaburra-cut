cask "kookaburra-cut" do
  version "0.22.4"
  sha256 "a71315babdc38eac53dfcb75163416709721b8edb515db1385ac214c86e35278"

  url "https://github.com/michael-palmes/kookaburra-cut/releases/download/v#{version}/KookaburraCut-#{version}.dmg"
  name "Kookaburra Cut"
  desc "Deterministic animated-video studio for product launch films"
  homepage "https://kookaburracut.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :tahoe

  app "Kookaburra Cut.app"

  # Casks cannot delete Keychain items: remove "Kookaburra Cut pack signing key" in Keychain Access.
  zap trash: [
    "~/Kookaburra Cut/_autorun",
    "~/Kookaburra Cut/_bridge",
    "~/Library/Application Support/com.mpalmes.kookaburracut",
    "~/Library/Caches/com.mpalmes.kookaburracut",
    "~/Library/Preferences/com.mpalmes.kookaburracut.plist",
    "~/Library/WebKit/com.mpalmes.kookaburracut",
  ]
end
