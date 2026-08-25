class MeetingPrd < Formula
  desc "Google Meet transcript to ClickUp tickets, with a Slack approval gate"
  homepage "https://github.com/yashp2303/meeting-prd"
  url "https://github.com/yashp2303/meeting-prd/releases/download/v0.1.4/meeting-prd.js"
  sha256 "fd1db425246d5fdf18a1fbaba780c2398b65ef4178ab2a45b1012adaaa0b37b8"
  version "0.1.4"
  license "MIT"

  # The CLI ships as one esbuild bundle with no runtime dependencies, so node
  # is all that is needed. Nothing is compiled at install time.
  depends_on "node"

  def install
    # Homebrew stages a plain-file download under its cache name
    # (meeting-prd--<version>.js), not the URL basename, so match by glob
    # rather than hardcoding a filename that may not exist.
    js = Dir["*.js"].first
    odie "no .js payload found in the download" if js.nil?
    bin.install js => "meeting-prd"
  end

  def caveats
    <<~EOS
      Run the setup wizard before anything else:

        meeting-prd init

      It prompts for your Groq, Vexa, Google Calendar, Slack and ClickUp
      credentials, verifies each one against its live API, and writes them to
      ~/.meeting-prd/config.json (chmod 600). No credentials ship with this
      formula.

      Then:

        meeting-prd doctor    # confirm every service is reachable
        meeting-prd tick      # run the pipeline once
        meeting-prd watch     # run it every 5 minutes
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/meeting-prd --version")
    assert_match "meeting-prd", shell_output("#{bin}/meeting-prd help")
  end
end
