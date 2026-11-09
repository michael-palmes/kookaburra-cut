cask "kookaburra-cut" do
  version "0.22.2"
  sha256 "7ae5fd102ab1c6ba29e584adbda0418ae7699b2118b9ec614fab792ceebbb252"

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
