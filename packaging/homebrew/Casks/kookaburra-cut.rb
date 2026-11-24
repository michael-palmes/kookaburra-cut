cask "kookaburra-cut" do
  version "0.24.0"
  sha256 "d706b79c4c58d06ab3f4d574d575439f320cf0310d89c70676aa3627fba87bb3"

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
