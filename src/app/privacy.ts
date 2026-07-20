// "How it stays private" — plain-language explainer page, adapted from the
// supplied design to ExcelTools (spreadsheets, SQL + Python engines). Linked
// from the sidebar's Private-by-design block; content is truthful for this app.

export function renderPrivacy(content: HTMLElement): void {
  content.innerHTML = `
  <div class="pv-page">
    <a class="pv-back" href="#/">← Back to the tools</a>

    <div class="pv-brandline">
      <span class="brand-mark" aria-hidden="true">Xt</span>
      <span class="pv-kicker">Private by design</span>
    </div>
    <h1 class="pv-h1">Why your files never leave this computer</h1>
    <p class="pv-lede">A plain-language explanation — no engineering degree required. Two minutes.</p>

    <div class="pv-card">
      <div class="pv-card-kicker">The short version</div>
      <p class="pv-big">Most websites work like a courier service: you hand your documents over, they get
      carried to a company's computer somewhere else, processed there, and the results come back.
      <b>This tool works like hiring an accountant who comes to your office.</b> The whole "brain" of the
      tool is downloaded to your computer once, and then it does all its work right there. Your
      spreadsheets are never handed to anyone.</p>
    </div>

    <h2 class="pv-h2">What actually happens, step by step</h2>
    <div class="pv-steps">
      <div class="pv-step"><span class="pv-n">1</span><p><b>You open the page.</b> Your browser downloads the
        tool itself — the reading and calculation engines. This is the only download, and it contains no
        data of yours. Think of it as the empty ledger book and the accountant, arriving together.</p></div>
      <div class="pv-step"><span class="pv-n">2</span><p><b>You drop in your Excel files.</b> They go from one
        part of your computer's memory to another part of your computer's memory. That's the whole
        journey. No upload bar, because there is no upload.</p></div>
      <div class="pv-step"><span class="pv-n">3</span><p><b>The engines do the work.</b> Converting, merging,
        comparing, SQL queries, Python notebooks — all of it runs inside the browser window in front of
        you, using your computer's own processor.</p></div>
      <div class="pv-step"><span class="pv-n">4</span><p><b>You close the tab.</b> Everything is wiped —
        files, figures, results. Nothing was saved anywhere, so there is nothing to delete, leak, or
        subpoena.</p></div>
    </div>

    <h2 class="pv-h2">What is "WebAssembly"?</h2>
    <p class="pv-p">You may see the word WebAssembly (or "WASM") mentioned. It's the technology that makes
      this possible, and the idea is simple:</p>
    <p class="pv-p">Browsers were originally built to show pages, not to do heavy accounting work.
      WebAssembly is a standard — built into Chrome, Edge, Firefox and Safari — that lets a browser run
      <i>real, full-strength software</i> at nearly the speed of an installed program. It's how things
      like Google Earth and Photoshop's web version run in a browser.</p>
    <p class="pv-p pv-gap">We use it to run a professional <b>SQL database</b> (DuckDB) and <b>Python with
      pandas</b> — the same data-analysis software used by banks and audit firms — entirely inside your
      browser tab. Crucially, WebAssembly programs run in a <b>sealed box</b>: the browser physically
      prevents them from reaching into your hard drive or sending your files out. They can only touch
      what you explicitly drop in.</p>

    <h2 class="pv-h2">Don't take our word for it</h2>
    <p class="pv-p">You can verify this yourself, in about a minute:</p>
    <div class="pv-card pv-gap">
      <ol class="pv-ol">
        <li>Load the tool, then <b>switch off your Wi-Fi</b> (or unplug the network cable).</li>
        <li>Drop in your files and run anything. <b>It works exactly the same</b> — proof that nothing
          needed to travel anywhere.</li>
        <li>For the technically curious: press <code class="pv-key">F12</code>, open the <b>Network</b>
          tab, and watch it stay empty while your files are processed. (Our automated tests do exactly
          this check on every release.)</li>
      </ol>
    </div>

    <h2 class="pv-h2">The plain commitments</h2>
    <div class="pv-grid">
      <div class="pv-commit"><b>✓ No upload.</b> Your files are never transmitted, to us or anyone.</div>
      <div class="pv-commit"><b>✓ No account.</b> We don't know who you are, and don't need to.</div>
      <div class="pv-commit"><b>✓ No storage.</b> Close the tab and everything is gone.</div>
      <div class="pv-commit"><b>✓ No tracking.</b> No analytics on your files, figures or clients.</div>
    </div>

    <div class="pv-cta"><a class="btn" href="#/">← Back to the tools</a></div>
  </div>`;
}
