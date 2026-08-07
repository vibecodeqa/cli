/** All CSS for the HTML report, extracted for maintainability. */

export const CSS = `
:root{--bg:#09090b;--card:#111115;--border:#1e1e24;--text:#e5e5e5;--muted:#6b7280;--pass:#22c55e;--fail:#ef4444;--warn:#eab308;--info:#6366f1;--accent:#818cf8;--side-w:200px;--top-h:42px;--nav-bg:#0c0c0fdd;--side-bg:#0c0c0f;--hover:#14141a;--dim:#555;--card-alt:#0d0d12}
[data-theme="light"]{--bg:#f5f5f7;--card:#ffffff;--border:#e2e4e9;--text:#1a1a2e;--muted:#64748b;--pass:#16a34a;--fail:#dc2626;--warn:#ca8a04;--info:#4f46e5;--accent:#4f46e5;--nav-bg:#ffffffee;--side-bg:#fafafa;--hover:#eef0f5;--dim:#94a3b8;--card-alt:#f0f0f5}
html{font-size:17px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Inter",system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
code{font-family:"SF Mono",Menlo,monospace;font-size:0.85em}

/* ── Top nav ── */
.top{position:sticky;top:0;z-index:30;background:var(--nav-bg);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:0 1.5rem;display:flex;align-items:center;height:var(--top-h)}
.logo{font-weight:800;font-size:1rem;margin-right:0.5rem;flex-shrink:0;text-decoration:none;color:var(--text)}
.logo span{color:var(--accent)}
.nav-project{font-size:0.72rem;color:var(--muted);font-weight:600;margin-right:1rem;padding:0.2rem 0.5rem;background:var(--card);border:1px solid var(--border);border-radius:4px;flex-shrink:0}
.nav-scroll{display:flex;align-items:center;gap:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex:1}
.nav-scroll::-webkit-scrollbar{display:none}
.tn{padding:0 0.7rem;font-size:0.78rem;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;transition:all 0.15s;white-space:nowrap;line-height:var(--top-h)}
.tn:hover{color:var(--text)}
.tn.active{color:var(--text);border-bottom-color:var(--accent)}
.hamburger{display:none;background:none;border:none;color:var(--muted);font-size:1.3rem;cursor:pointer;padding:0 0.4rem;line-height:var(--top-h)}

/* ── Sidebar ── */
.side{position:fixed;top:var(--top-h);left:0;bottom:0;width:var(--side-w);background:var(--side-bg);border-right:1px solid var(--border);overflow-y:auto;padding:0.6rem 0;font-size:0.7rem;z-index:20}
.side-section{padding:0.3rem 0;border-bottom:1px solid var(--border)}
.side-section:last-child{border-bottom:none}
.side-label{padding:0.2rem 0.8rem;font-size:0.6rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--dim);font-weight:600}
.side-score{font-size:1.4rem;font-weight:900;padding:0.2rem 0.8rem}
.side-cat{display:block;padding:0.3rem 0.8rem;color:var(--muted);font-weight:600;cursor:pointer;text-decoration:none;font-size:0.72rem}
.side-cat:hover{background:var(--hover);color:var(--text)}
.side-cat-active{color:var(--text);font-weight:700;border-left:2px solid var(--accent);padding-left:calc(0.8rem - 2px)}
.side-cat-title{padding:0.3rem 0.8rem;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--accent);font-weight:700}
.side-check{display:block;padding:0.15rem 0.8rem 0.15rem 0.8rem;color:var(--muted);cursor:pointer;text-decoration:none;font-size:0.65rem}
.side-check:hover{color:var(--text);background:#14141a}
.side-check span{display:inline-block;min-width:2.5rem;font-weight:700;font-size:0.6rem}
.side-stat{padding:0.15rem 0.8rem;font-size:0.7rem;color:var(--muted)}
.side-stat span{font-weight:800;font-size:0.8rem}
.side-views{padding-top:0.3rem}
.side-views .side-check{padding-left:0.8rem}

/* ── Content ── */
.content{margin-left:var(--side-w);padding:1.5rem 2rem;max-width:960px}

/* ── Overview ── */
.dash{display:flex;gap:2rem;margin-bottom:2rem;align-items:center;flex-wrap:wrap}
.hero{display:flex;align-items:center;gap:1rem}
.hero svg{width:100px;height:100px}
.hc{display:flex;flex-direction:column}
.hg{font-size:2.5rem;font-weight:900;line-height:1}
.hs{font-size:1rem;font-weight:600}
.hd{font-size:0.68rem;color:var(--muted)}
.radar{flex:1;display:flex;justify-content:center}
.radar svg{max-width:240px;width:100%}
.cats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0.6rem;margin-bottom:2rem}
.cc{background:var(--card);border:1px solid var(--border);border-radius:0.6rem;padding:0.8rem;transition:border-color 0.15s;text-decoration:none;color:var(--text);display:block}
.cc:hover{border-color:var(--accent)}
.cc-s{font-size:1.8rem;font-weight:900}
.cc-l{font-size:0.75rem;color:var(--muted)}
.cc-m{margin-top:0.3rem;display:flex;gap:0.25rem}
.mc{font-size:0.65rem;font-weight:800}
h3{font-size:0.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.5rem}

/* ── Overview sections ── */
.ov-section{margin-bottom:1.5rem}
.ov-issue{font-size:0.68rem;font-family:"SF Mono",monospace;padding:0.2rem 0;display:flex;gap:0.4rem;align-items:baseline;border-bottom:1px solid var(--border)}
.ov-issue .is{flex-shrink:0}
.ov-issue.error .is{color:var(--fail)}
.ov-issue.warning .is{color:var(--warn)}
.ov-check{color:var(--muted);width:70px;flex-shrink:0;font-size:0.62rem}
.ov-loc{color:var(--accent);flex-shrink:0;font-size:0.62rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-msg{flex:1;word-break:break-word}
.ov-link{display:block;margin-top:0.5rem;font-size:0.72rem;color:var(--accent);text-decoration:none}
.ov-link:hover{text-decoration:underline}

/* ── Timeline ── */
.timeline{margin:0.5rem 0;overflow-x:auto}
.timeline svg{max-width:100%}

/* ── Bar chart ── */
.bars{margin-bottom:1.5rem}
.brow{display:flex;align-items:center;gap:0.4rem;margin-bottom:0.25rem;font-size:0.72rem}
.bl{width:90px;text-align:right;color:var(--muted);flex-shrink:0}
.bb{flex:1;height:14px;background:var(--card);border-radius:3px;overflow:hidden;border:1px solid var(--border)}
.bf{height:100%;border-radius:2px}
.bv{width:36px;font-weight:700;font-size:0.68rem}
.stack{display:flex;gap:0.35rem;flex-wrap:wrap;margin-top:1rem}
.stack span{background:var(--card);border:1px solid var(--border);padding:0.1rem 0.45rem;border-radius:9999px;font-size:0.62rem;color:var(--muted)}

/* ── Workspace / Repo structure ── */
.ws-info{display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem;font-size:0.72rem;color:var(--muted)}
.ws-badge{background:var(--accent);color:#fff;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.65rem;font-weight:700}
.ws-evidence{display:flex;gap:0.35rem;flex-wrap:wrap;margin-bottom:0.5rem}
.ws-ev{max-width:100%;display:inline-flex;align-items:center;gap:0.35rem;background:var(--card);border:1px solid var(--border);border-radius:5px;padding:0.18rem 0.45rem;font-size:0.62rem;color:var(--muted)}
.ws-ev b{color:var(--accent);text-transform:uppercase;font-size:0.55rem}
.ws-ev code{color:var(--text);font-size:0.6rem}
.ws-ev small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-ev-rejected{border-color:#eab30855;background:#eab30810}
.ws-ev-rejected b{color:var(--warn)}
.ws-pkgs{display:flex;flex-direction:column;gap:0.15rem}
.ws-pkg{display:flex;gap:0.6rem;align-items:center;font-size:0.68rem;padding:0.15rem 0.4rem;background:var(--card);border-radius:4px}
.ws-project{display:grid;grid-template-columns:minmax(140px,1.2fr) 70px minmax(120px,1fr) auto;gap:0.6rem;align-items:center;font-size:0.68rem;padding:0.18rem 0.45rem;background:var(--card);border:1px solid var(--border);border-radius:4px}
.ws-path{font-family:monospace;color:var(--text);min-width:140px}
.ws-name{color:var(--muted);flex:1}
.ws-stack{color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-flags{color:var(--muted);font-size:0.6rem}
.ws-more{font-size:0.62rem;color:var(--muted);padding:0.2rem 0.4rem}

/* ── Scan scope ── */
.scope-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.5rem}
.scope-head h2{margin-bottom:0.2rem}
.scope-copy{opacity:1;background:var(--card);border:1px solid var(--border);color:var(--accent);font-size:0.68rem;padding:0.3rem 0.7rem;border-radius:6px;font-family:inherit;white-space:nowrap}
.scope-section{margin-bottom:1.7rem}
.scope-table{display:flex;flex-direction:column;gap:0.18rem}
.scope-row{display:grid;grid-template-columns:minmax(150px,0.4fr) minmax(0,1fr);gap:0.6rem;align-items:start;font-size:0.7rem;padding:0.22rem 0;border-bottom:1px solid var(--border)}
.scope-k{color:var(--muted);font-weight:700}
.scope-v{display:flex;flex-wrap:wrap;gap:0.25rem;min-width:0;word-break:break-word}
.scope-v code{background:var(--card);border:1px solid var(--border);border-radius:4px;padding:0.05rem 0.28rem;color:var(--text);font-size:0.62rem;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.scope-empty{color:var(--dim);font-style:italic}
.scope-note{font-size:0.72rem}
.scope-evidence{margin-top:0.6rem}
.scope-projects{display:flex;flex-direction:column;gap:0.65rem}
.scope-project{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:0.75rem 0.9rem}
.scope-project-head{display:flex;justify-content:space-between;align-items:center;gap:0.8rem;margin-bottom:0.25rem}
.scope-path{font-family:"SF Mono",monospace;color:var(--text);font-size:0.76rem;font-weight:700;word-break:break-word}
.scope-kind{color:var(--muted);font-size:0.62rem;margin-left:0.45rem;text-transform:uppercase}
.scope-status{font-size:0.58rem;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;border:1px solid currentColor;border-radius:9999px;padding:0.12rem 0.45rem;white-space:nowrap}
.scope-scanned{color:var(--pass)}
.scope-unavailable{color:var(--warn)}
.scope-meta{font-size:0.66rem;color:var(--muted);margin-bottom:0.5rem}
.scope-project-table{margin-top:0.4rem}
.scope-commands{display:flex;flex-direction:column;gap:0.2rem;margin-top:0.6rem;padding-top:0.5rem;border-top:1px solid var(--border);font-size:0.65rem;color:var(--muted)}
.scope-commands code{color:var(--accent)}
.scope-rejected-list{display:flex;flex-direction:column;gap:0.25rem}
.scope-rejected{display:grid;grid-template-columns:minmax(140px,0.6fr) auto minmax(0,1fr);gap:0.6rem;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:0.45rem 0.6rem;font-size:0.68rem}
.scope-reason{color:var(--muted);word-break:break-word}
.scope-json{background:var(--card-alt);border:1px solid var(--border);border-radius:8px;padding:0.75rem;overflow:auto;font-size:0.62rem;line-height:1.5;max-height:420px}

/* ── Category pages ── */
.cat-head{margin-bottom:0.3rem}
.bar2{height:4px;background:var(--card);border-radius:2px;margin-bottom:1.5rem;overflow:hidden}
.bf2{height:100%;border-radius:2px}
.check-section{margin-bottom:2.5rem;padding-top:0.5rem;border-top:1px solid var(--border)}
.check-section:first-of-type{border-top:none}

/* ── Check detail ── */
.ch-head{display:flex;align-items:center;gap:0.7rem;margin-bottom:0.8rem}
.ch-g{font-size:2rem;font-weight:900}
.ch-s{display:block;font-size:0.7rem;color:var(--muted)}
.pri{font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;padding:0.15rem 0.5rem;border-radius:9999px;border:1px solid currentColor;flex-shrink:0}
.info-panel{background:var(--card-alt);border:1px solid var(--border);border-radius:0.5rem;padding:0.7rem 0.9rem;margin-bottom:1rem;font-size:0.72rem;line-height:1.6}
.ip-row{margin-bottom:0.4rem;display:flex;gap:0.5rem}
.ip-row:last-child{margin-bottom:0}
.ip-label{color:var(--accent);font-weight:700;min-width:2.5rem;flex-shrink:0}
.skip-r{color:var(--muted);font-style:italic;font-size:0.78rem}
.kvs{display:flex;gap:0.6rem;flex-wrap:wrap;margin-bottom:1rem}
.kv{background:var(--card);border:1px solid var(--border);border-radius:0.4rem;padding:0.3rem 0.6rem;font-size:0.7rem}
.k{color:var(--muted);margin-right:0.3rem}
.v{font-weight:600}

/* ── Issue list grouped by file ── */
.iss-list{margin-top:1rem}
.fg{margin-bottom:0.8rem}
.fn{font-size:0.72rem;font-weight:600;font-family:"SF Mono",monospace;padding:0.3rem 0;border-bottom:1px solid var(--border);margin-bottom:0.2rem;display:flex;align-items:center;gap:0.5rem}
.fc{background:var(--border);border-radius:9999px;padding:0 0.4rem;font-size:0.6rem;color:var(--muted)}
.ir{font-size:0.65rem;font-family:"SF Mono",monospace;padding:0.12rem 0 0.12rem 0.5rem;display:flex;gap:0.4rem;align-items:baseline}
.is{font-weight:800;font-size:0.55rem;width:0.9rem;text-align:center;border-radius:2px;flex-shrink:0}
.ir.error .is{color:var(--fail);background:#ef444418}
.ir.warning .is{color:var(--warn);background:#eab30818}
.ir.info .is{color:var(--info);background:#6366f118}
.il{color:var(--accent);min-width:2rem;flex-shrink:0}
.im{flex:1;word-break:break-word}
.iru{color:var(--dim);font-size:0.55rem}

/* ── Source code snippets ── */
.src-block{background:var(--card-alt);border:1px solid var(--border);border-radius:6px;margin:0.3rem 0 0.5rem 0.5rem;padding:0.3rem 0;font-family:"SF Mono",Menlo,monospace;font-size:0.62rem;line-height:1.6;overflow-x:auto}
.src-ln{padding:0 0.5rem;white-space:pre}
.src-hl{padding:0 0.5rem;white-space:pre;background:#eab30815;border-left:2px solid var(--warn)}
.src-num{color:var(--dim);margin-right:0.5rem;user-select:none;display:inline-block;min-width:2.5rem;text-align:right}
.src-prompt{padding:0.3rem 0.5rem;border-top:1px solid var(--border);display:flex;justify-content:flex-end}
.src-fix-btn{background:var(--card);border:1px solid var(--border);color:var(--accent);font-size:0.62rem;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-family:inherit}
.src-fix-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}

/* ── All issues table ── */
.isf{color:var(--muted);font-size:0.75rem;margin-bottom:0.8rem}
.it{width:100%;border-collapse:collapse;font-size:0.68rem}
.it th{text-align:left;padding:0.35rem 0.4rem;color:var(--muted);font-size:0.62rem;text-transform:uppercase;border-bottom:1px solid var(--border)}
.it td{padding:0.25rem 0.4rem;border-bottom:1px solid var(--border);font-family:"SF Mono",monospace;font-size:0.62rem}
.it tr.error .is2{color:var(--fail)}
.it tr.warning .is2{color:var(--warn)}
.is2{font-weight:800;width:1rem}
.ic2{color:var(--muted);width:70px}
.il2{color:var(--muted)}
.iru2{color:var(--dim);font-size:0.58rem}

/* ── File health ── */
.fr{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem;font-size:0.7rem}
.ff{width:200px;font-family:"SF Mono",monospace;font-size:0.65rem;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fb{flex:1;height:12px;background:var(--card);border-radius:3px;overflow:hidden;border:1px solid var(--border)}
.fbf{height:100%;border-radius:2px}
.fv{width:50px;font-size:0.65rem;color:var(--muted);flex-shrink:0}
.hm-row{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.2rem;font-size:0.7rem}
.hm-name{width:200px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:"SF Mono",monospace;font-size:0.65rem}
.hm-bar{height:14px;border-radius:3px;min-width:4px}
.hm-count{color:var(--muted);font-size:0.65rem;flex-shrink:0;min-width:50px}
.hm-checks{font-size:0.58rem;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Premium cards ── */
.pro-card{background:linear-gradient(135deg,#0f0f1a 0%,#13131f 100%);border:1px solid #2a2a3d;border-radius:0.75rem;padding:1.5rem;position:relative;overflow:hidden}
.pro-card::before{content:"";position:absolute;top:-50%;right:-50%;width:200%;height:200%;background:radial-gradient(circle,#6366f108 0%,transparent 70%);pointer-events:none}
.pro-badge{display:inline-block;background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;font-size:0.6rem;font-weight:800;padding:0.15rem 0.5rem;border-radius:9999px;letter-spacing:0.06em;margin-bottom:0.6rem}
.pro-desc{color:var(--muted);font-size:0.78rem;line-height:1.6;margin-bottom:0.8rem}
.pro-cta{color:#6366f1;font-size:0.72rem;font-weight:600;margin-top:1rem}
.sn-pro{opacity:0.7}

/* ── Trends page ── */
.trend-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem;margin-top:0.5rem}
.trend-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:0.8rem}
.trend-header{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem}
.trend-name{font-size:0.78rem;font-weight:700;flex:1}
.trend-score{font-size:1.1rem;font-weight:900}
.trend-chart{overflow:hidden}
.trend-chart svg{width:100%;height:60px}
.trend-table{margin-bottom:1.5rem}
.trend-row{display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;border-bottom:1px solid var(--border);font-size:0.75rem}
.trend-row-name{flex:1;font-weight:600}
.trend-row-val{width:2rem;text-align:center;color:var(--muted)}
.trend-row-arrow{color:var(--muted);font-size:0.6rem}
.trend-row-delta{width:2.5rem;text-align:right;font-weight:700}

.footer{text-align:center;color:var(--muted);font-size:0.58rem;margin-top:2rem;padding:0.8rem 0;border-top:1px solid var(--border)}
.footer a{color:var(--muted)}
.muted{color:var(--muted)}
.deeper-tools code{background:var(--border);padding:0.1rem 0.4rem;border-radius:4px;font-size:0.62rem;color:var(--accent);margin-right:0.3rem}
.flink{color:var(--accent);text-decoration:none;font-family:"SF Mono",monospace}.flink:hover{text-decoration:underline}
.arch-svg{margin:1rem 0;overflow-x:auto;-webkit-overflow-scrolling:touch}
.arch-svg svg{border-radius:8px}
.cp-btn{background:none;border:none;cursor:pointer;font-size:0.6rem;opacity:0.3;padding:0 0.2rem;flex-shrink:0}.cp-btn:hover{opacity:1}
.ir:hover .cp-btn{opacity:0.6}

/* ── Mobile: hamburger collapses both navs ── */
@media(max-width:768px){
.hamburger{display:block}
.nav-scroll{display:none}
.nav-scroll.open{display:flex;position:absolute;top:var(--top-h);left:0;right:0;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap;padding:0.3rem 0.5rem;z-index:25}
.side{display:none}
.side.open{display:block;z-index:25}
.top{padding:0 0.8rem}
.logo{font-size:0.85rem;margin-right:0.5rem}
.content{margin-left:0;padding:0.8rem}
.cats{grid-template-columns:1fr 1fr}
.dash{flex-direction:column;gap:1rem}
.hero svg{width:80px;height:80px}
.hg{font-size:2rem}
.radar svg{max-width:180px}
.bl{width:60px;font-size:0.62rem}
.bv{width:30px;font-size:0.6rem}
.it{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
.ff{width:120px;font-size:0.58rem}
.hm-name{width:120px;font-size:0.58rem}
.hm-checks{display:none}
.ov-check{width:50px}
.ov-loc{max-width:120px}
.ir{font-size:0.6rem}
.ch-head{flex-wrap:wrap}
.ch-g{font-size:1.5rem}
.info-panel{font-size:0.68rem;padding:0.5rem 0.6rem}
.ip-row{flex-direction:column;gap:0.1rem}
.kvs{gap:0.4rem}
.kv{font-size:0.62rem;padding:0.2rem 0.4rem}
.arch-svg svg{min-width:400px}
.scope-head{flex-direction:column}
.scope-row{grid-template-columns:1fr;gap:0.15rem}
.scope-project-head{align-items:flex-start;flex-direction:column}
.scope-rejected{grid-template-columns:1fr;gap:0.25rem}
.scope-v code{white-space:normal}
}
@media(max-width:480px){
.cats{grid-template-columns:1fr}
.tn{padding:0 0.4rem;font-size:0.65rem}
.ff{width:90px}
.hm-name{width:90px}
.ov-check{display:none}
}

/* ── Feature Map (Pro) ── */
.fm-header{margin-bottom:1.5rem}
.fm-header h2{display:flex;align-items:center;gap:0.6rem}
.fm-stats{display:flex;gap:1.5rem;margin-bottom:2rem;padding:1rem 1.2rem;background:var(--card);border:1px solid var(--border);border-radius:12px}
.fm-stat{display:flex;flex-direction:column;align-items:center}
.fm-stat-n{font-size:1.6rem;font-weight:900;line-height:1.2}
.fm-stat-l{font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;font-weight:600}
.fm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem}
.fm-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.2rem;transition:border-color 0.15s}
.fm-card:hover{border-color:#333}
.fm-card-issue{border-color:#eab30830;background:linear-gradient(135deg,var(--card) 0%,#1a1a0f 100%)}
.fm-card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.4rem}
.fm-card-label{font-weight:800;font-size:0.95rem}
.fm-card-desc{font-size:0.72rem;color:var(--muted);margin-bottom:0.5rem;line-height:1.4}
.fm-card-dir{font-size:0.65rem;color:var(--dim);font-family:"SF Mono",monospace;margin-bottom:0.6rem}
.fm-card-badge{font-size:0.6rem;font-weight:700;padding:0.15rem 0.5rem;border-radius:9999px;white-space:nowrap}
.fm-ok{background:#22c55e18;color:var(--pass)}
.fm-warn{background:#eab30818;color:var(--warn)}
.fm-info{background:#6366f118;color:var(--info)}
.fm-card-files{display:flex;flex-direction:column;gap:0.15rem;margin-bottom:0.6rem}
.fm-file{font-size:0.68rem;color:var(--muted);font-family:"SF Mono",monospace}
.fm-file a{color:var(--accent);text-decoration:none}
.fm-file a:hover{text-decoration:underline}
.fm-more{color:var(--dim);font-style:italic}
.fm-findings{margin-top:0.6rem;padding-top:0.6rem;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:0.3rem}
.fm-finding{display:flex;align-items:baseline;gap:0.4rem;font-size:0.68rem;line-height:1.4}
.fm-f-sev{font-weight:800;font-size:0.6rem;width:1rem;flex-shrink:0}
.fm-f-warn .fm-f-sev{color:var(--warn)}
.fm-f-info .fm-f-sev{color:var(--info)}
.fm-f-loc{color:var(--dim);font-family:"SF Mono",monospace;flex-shrink:0}
.fm-f-loc a{color:var(--accent);text-decoration:none}
.fm-f-msg{color:var(--text)}
.fm-f-rule{color:var(--dim);font-size:0.6rem;font-family:"SF Mono",monospace}

/* Teaser (no Pro key) */
.fm-teaser{margin-top:1.5rem}
.fm-teaser-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;margin-bottom:2rem}
.fm-card-blur{filter:blur(3px);opacity:0.5;pointer-events:none;user-select:none}
.fm-cta{text-align:center;padding:2rem;background:linear-gradient(135deg,#0f0f1a,#13131f);border:1px solid #2a2a3d;border-radius:12px}
.fm-cta code{background:#1a1a2e;padding:0.2rem 0.5rem;border-radius:4px;font-size:0.8rem}
@media(max-width:640px){
.fm-grid,.fm-teaser-grid{grid-template-columns:1fr}
.fm-stats{flex-wrap:wrap;gap:1rem}
}

/* ── Preferences panel ── */
.prefs-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:0.72rem;cursor:pointer;padding:0.2rem 0.5rem;border-radius:6px;margin-left:auto;flex-shrink:0;font-family:inherit;line-height:1.4}
.prefs-btn:hover{color:var(--text);border-color:var(--dim)}
.prefs-panel{display:none;position:absolute;top:var(--top-h);right:1rem;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:0.8rem 1rem;z-index:40;min-width:200px;box-shadow:0 8px 30px #0008}
.prefs-panel.open{display:block}
.prefs-label{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--dim);font-weight:600;margin-bottom:0.3rem}
.prefs-label:not(:first-child){margin-top:0.7rem}
.prefs-row{display:flex;gap:0.3rem}
.prefs-opt{background:var(--card-alt);border:1px solid var(--border);color:var(--muted);font-size:0.68rem;padding:0.25rem 0.6rem;border-radius:6px;cursor:pointer;font-family:inherit;transition:all 0.1s}
.prefs-opt:hover{color:var(--text);border-color:var(--dim)}
.prefs-opt.active{background:var(--accent);color:#fff;border-color:var(--accent)}
[data-theme="light"] .prefs-panel{box-shadow:0 8px 30px #0002}

/* ── Actions page ── */
.act-summary{display:flex;gap:1.5rem;margin-bottom:2rem}
.act-stat{text-align:center}
.act-stat-n{display:block;font-size:1.8rem;font-weight:700;line-height:1.2}
.act-stat-l{font-size:0.72rem;color:var(--muted)}
.act-section{margin-bottom:2.5rem}
.act-section h3{display:flex;align-items:center;gap:0.5rem;font-size:1rem;margin-bottom:0.3rem}
.act-icon{display:inline-flex;align-items:center;justify-content:center;width:1.6rem;height:1.6rem;border-radius:8px;font-size:0.9rem}
.act-count{font-size:0.72rem;color:var(--muted);font-weight:400}
.act-desc{font-size:0.78rem;color:var(--muted);margin-bottom:0.8rem}
.act-cmd{margin-bottom:1rem}
.act-cmd code{display:inline-block;background:var(--card);border:1px solid var(--border);padding:0.3rem 0.8rem;border-radius:6px;font-size:0.78rem;color:var(--accent)}
.act-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:0.8rem}
.act-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:0.8rem 1rem}
.act-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem}
.act-check{font-size:0.78rem;font-weight:600}
.act-fix{font-size:0.78rem;color:var(--pass);margin-bottom:0.5rem;padding:0.3rem 0.5rem;background:var(--pass)10;border-radius:4px}
.act-rec{font-size:0.75rem;color:var(--muted);margin-bottom:0.5rem;line-height:1.4}
.act-item{font-size:0.72rem;color:var(--dim);padding:0.15rem 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act-details{margin-top:0.5rem}
.act-details summary{font-size:0.75rem;color:var(--muted);cursor:pointer}
.act-table{width:100%;font-size:0.72rem;margin-top:0.3rem}
.act-table td{padding:0.2rem 0.4rem;border-bottom:1px solid var(--border)}
.act-table .act-check{color:var(--muted);white-space:nowrap}
@media(max-width:600px){.act-summary{flex-direction:column;gap:0.8rem;align-items:center}.act-grid{grid-template-columns:1fr}}

/* ── Delta banner ── */
.delta-banner{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.2rem 1.5rem;margin-bottom:2rem}
.delta-head{display:flex;align-items:center;gap:1rem;margin-bottom:0.5rem}
.delta-title{font-weight:700;font-size:0.9rem}
.delta-score{font-size:0.85rem;color:var(--muted)}
.delta-arrow{font-weight:800;font-size:1rem}
.delta-stats{display:flex;gap:1.2rem;font-size:0.78rem;margin-bottom:0.5rem}
.delta-checks{display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.5rem}
.delta-chip{font-size:0.7rem;padding:0.15rem 0.5rem;background:var(--card-alt);border:1px solid var(--border);border-radius:4px;white-space:nowrap}
.delta-fixed,.delta-new{font-size:0.75rem;color:var(--muted);margin-top:0.3rem}
`;
