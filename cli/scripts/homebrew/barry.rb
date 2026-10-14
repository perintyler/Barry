# release.mjs renders this file; edit this template, not the tap's copy.
class Barry < Formula
  desc "Experimental personal agent platform release"
  homepage "https://barry.rocks"
  url "@@URL@@"
  version "@@VERSION@@"
  sha256 "@@SHA256@@"
  license :cannot_represent
  keg_only "linked checkout is the primary install channel; this release formula is experimental"

  depends_on arch: :arm64
  depends_on :macos
  skip_clean "libexec"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/barry"
  end

  def caveats
    <<~EOS
      Linked checkout is the primary install channel; this release is experimental.
      Run #{opt_bin}/barry setup after the first install.
      Run #{opt_bin}/barry upgrade after every brew upgrade barry.
      Run #{opt_bin}/barry setup --uninstall before brew uninstall barry.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/barry --version").strip
  end
end
