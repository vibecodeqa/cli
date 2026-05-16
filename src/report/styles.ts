/** All CSS for the HTML report, extracted for maintainability. */

export const CSS = `
:root{--bg:#09090b;--card:#111115;--border:#1e1e24;--text:#e5e5e5;--muted:#6b7280;--pass:#22c55e;--fail:#ef4444;--warn:#eab308;--info:#6366f1;--accent:#818cf8}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Inter",system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
code{font-family:"SF Mono",Menlo,monospace;font-size:0.85em}

/* Top nav — split into dimensions (left) and views (right) */
.top{position:sticky;top:0;z-index:20;background:#0c0c0fcc;backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:0 2rem;display:flex;align-items:center;gap:0}
.logo{font-weight:800;font-size:1rem;margin-right:1.5rem;padding:0.7rem 0;flex-shrink:0}
.logo span{color:var(--accent)}
.nav-dims{display:flex;align-items:center;gap:0}
.nav-views{margin-left:auto;display:flex;align-items:center;gap:0;border-left:1px solid var(--border);padding-left:0.3rem}
.tn{padding:0.7rem 0.8rem;font-size:0.78rem;color:var(--muted);text-decoration:none;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s}
.tn:hover{color:var(--text)}
.tn.active{color:var(--text);border-bottom-color:var(--accent)}
.tn-view{font-size:0.72rem;opacity:0.8}
.tn-view.active{opacity:1}

/* Sidebar */
.side{position:fixed;top:42px;left:0;bottom:0;width:200px;background:#0c0c0f;border-right:1px solid var(--border);overflow-y:auto;padding:0.8rem 0;font-size:0.7rem;z-index:10}
.side-section{padding:0.3rem 0;border-bottom:1px solid var(--border)}
.side-section:last-child{border-bottom:none}
.side-score{font-size:1.4rem;font-weight:900;padding:0.3rem 0.8rem}
.side-cat{display:block;padding:0.3rem 0.8rem;color:var(--text);font-weight:700;cursor:pointer;text-decoration:none;font-size:0.72rem}
.side-cat:hover{background:#14141a}
.side-check{display:block;padding:0.2rem 0.8rem 0.2rem 1.2rem;color:var(--muted);cursor:pointer;text-decoration:none;font-size:0.65rem}
.side-check:hover{color:var(--text);background:#14141a}
.side-check span{display:inline-block;width:1rem;font-weight:800;text-align:center}
.side-views{padding-top:0.5rem}
.side-views-label{padding:0.2rem 0.8rem;font-size:0.6rem;text-transform:uppercase;letter-spacing:0.05em;color:#444;font-weight:600}
.side-views .side-check{padding-left:0.8rem}

/* Content */
.content{max-width:900px;margin-left:200px;padding:2rem}
.page{display:none;animation:fadeIn 0.15s}
.page.active{display:block}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}

/* Overview */
.dash{display:flex;gap:2rem;margin-bottom:2rem;align-items:center;flex-wrap:wrap}
.hero{display:flex;align-items:center;gap:1rem}
.hero svg{width:100px;height:100px}
.hc{display:flex;flex-direction:column}
.hg{font-size:2.5rem;font-weight:900;line-height:1}
.hs{font-size:1rem;font-weight:600}
.hd{font-size:0.68rem;color:var(--muted)}
.radar{flex:1;display:flex;justify-content:center}
.radar svg{max-width:240px;width:100%}
.cats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0.6rem;margin-bottom:2rem}
.cc{background:var(--card);border:1px solid var(--border);border-radius:0.6rem;padding:0.8rem;cursor:pointer;transition:border-color 0.15s}
.cc:hover{border-color:var(--accent)}
.cc-s{font-size:1.8rem;font-weight:900}
.cc-l{font-size:0.75rem;color:var(--muted)}
.cc-m{margin-top:0.3rem;display:flex;gap:0.25rem}
.mc{font-size:0.65rem;font-weight:800}
h3{font-size:0.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.5rem}

/* Overview sections */
.ov-section{margin-bottom:1.5rem}
.ov-issue{font-size:0.68rem;font-family:"SF Mono",monospace;padding:0.2rem 0;display:flex;gap:0.4rem;align-items:baseline;border-bottom:1px solid var(--border)}
.ov-issue .is{flex-shrink:0}
.ov-issue.error .is{color:var(--fail)}
.ov-issue.warning .is{color:var(--warn)}
.ov-check{color:var(--muted);width:70px;flex-shrink:0;font-size:0.62rem}
.ov-loc{color:var(--accent);flex-shrink:0;font-size:0.62rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-msg{flex:1;word-break:break-word}
.ov-link{display:block;margin-top:0.5rem;font-size:0.72rem;color:var(--accent);cursor:pointer;text-decoration:none}
.ov-link:hover{text-decoration:underline}

/* Timeline */
.timeline{margin:0.5rem 0;overflow-x:auto}
.timeline svg{max-width:100%}

/* Bar chart */
.bars{margin-bottom:1.5rem}
.brow{display:flex;align-items:center;gap:0.4rem;margin-bottom:0.25rem;font-size:0.72rem}
.bl{width:90px;text-align:right;color:var(--muted);flex-shrink:0}
.bb{flex:1;height:14px;background:var(--card);border-radius:3px;overflow:hidden;border:1px solid var(--border)}
.bf{height:100%;border-radius:2px}
.bv{width:36px;font-weight:700;font-size:0.68rem}
.stack{display:flex;gap:0.35rem;flex-wrap:wrap;margin-top:1rem}
.stack span{background:var(--card);border:1px solid var(--border);padding:0.1rem 0.45rem;border-radius:9999px;font-size:0.62rem;color:var(--muted)}

/* Category pages */
.cat-head{margin-bottom:0.3rem}
.bar2{height:4px;background:var(--card);border-radius:2px;margin-bottom:1rem;overflow:hidden}
.bf2{height:100%;border-radius:2px}
.sub-nav{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:1rem;flex-wrap:wrap}
.sn{padding:0.5rem 0.8rem;font-size:0.75rem;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent}
.sn:hover{color:var(--text)}
.sn.active{color:var(--text);border-bottom-color:var(--accent)}
.sp{display:none}.sp.active{display:block}

/* Check detail */
.ch-head{display:flex;align-items:center;gap:0.7rem;margin-bottom:0.8rem}
.ch-g{font-size:2rem;font-weight:900}
.ch-s{display:block;font-size:0.7rem;color:var(--muted)}
.pri{font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;padding:0.15rem 0.5rem;border-radius:9999px;border:1px solid currentColor;flex-shrink:0}
.info-panel{background:#0d0d12;border:1px solid var(--border);border-radius:0.5rem;padding:0.7rem 0.9rem;margin-bottom:1rem;font-size:0.72rem;line-height:1.6}
.ip-row{margin-bottom:0.4rem;display:flex;gap:0.5rem}
.ip-row:last-child{margin-bottom:0}
.ip-label{color:var(--accent);font-weight:700;min-width:2.5rem;flex-shrink:0}
.skip-r{color:var(--muted);font-style:italic;font-size:0.78rem}
.kvs{display:flex;gap:0.6rem;flex-wrap:wrap;margin-bottom:1rem}
.kv{background:var(--card);border:1px solid var(--border);border-radius:0.4rem;padding:0.3rem 0.6rem;font-size:0.7rem}
.k{color:var(--muted);margin-right:0.3rem}
.v{font-weight:600}

/* Issue list grouped by file */
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
.iru{color:#555;font-size:0.55rem}

/* All issues table */
.isf{color:var(--muted);font-size:0.75rem;margin-bottom:0.8rem}
.it{width:100%;border-collapse:collapse;font-size:0.68rem}
.it th{text-align:left;padding:0.35rem 0.4rem;color:var(--muted);font-size:0.62rem;text-transform:uppercase;border-bottom:1px solid var(--border)}
.it td{padding:0.25rem 0.4rem;border-bottom:1px solid var(--border);font-family:"SF Mono",monospace;font-size:0.62rem}
.it tr.error .is2{color:var(--fail)}
.it tr.warning .is2{color:var(--warn)}
.is2{font-weight:800;width:1rem}
.ic2{color:var(--muted);width:70px}
.il2{color:var(--muted)}
.iru2{color:#555;font-size:0.58rem}

/* File health (merged file map + heatmap) */
.fr{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem;font-size:0.7rem}
.ff{width:200px;font-family:"SF Mono",monospace;font-size:0.65rem;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fb{flex:1;height:12px;background:var(--card);border-radius:3px;overflow:hidden;border:1px solid var(--border)}
.fbf{height:100%;border-radius:2px}
.fv{width:50px;font-size:0.65rem;color:var(--muted);flex-shrink:0}
.fcs{font-size:0.6rem;color:#555}
.hm-row{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.2rem;font-size:0.7rem}
.hm-name{width:200px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:"SF Mono",monospace;font-size:0.65rem}
.hm-bar{height:14px;border-radius:3px;min-width:4px}
.hm-count{color:var(--muted);font-size:0.65rem;flex-shrink:0;min-width:50px}
.hm-checks{font-size:0.58rem;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Premium / coming-soon cards */
.pro-card{background:linear-gradient(135deg,#0f0f1a 0%,#13131f 100%);border:1px solid #2a2a3d;border-radius:0.75rem;padding:1.5rem;position:relative;overflow:hidden}
.pro-card::before{content:"";position:absolute;top:-50%;right:-50%;width:200%;height:200%;background:radial-gradient(circle,#6366f108 0%,transparent 70%);pointer-events:none}
.pro-badge{display:inline-block;background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;font-size:0.6rem;font-weight:800;padding:0.15rem 0.5rem;border-radius:9999px;letter-spacing:0.06em;margin-bottom:0.6rem}
.pro-desc{color:var(--muted);font-size:0.78rem;line-height:1.6;margin-bottom:0.8rem}
.pro-cta{color:#6366f1;font-size:0.72rem;font-weight:600;margin-top:1rem}
.sn-pro{opacity:0.7}

.footer{text-align:center;color:var(--muted);font-size:0.58rem;margin-top:2rem;padding:0.8rem 0;border-top:1px solid var(--border)}
.footer a{color:var(--muted)}
.flink{color:var(--accent);text-decoration:none;font-family:"SF Mono",monospace}.flink:hover{text-decoration:underline}
.arch-svg{margin:1rem 0;overflow-x:auto}
.arch-svg svg{border-radius:8px}
.cp-btn{background:none;border:none;cursor:pointer;font-size:0.6rem;opacity:0.3;padding:0 0.2rem;flex-shrink:0}.cp-btn:hover{opacity:1}
.ir:hover .cp-btn{opacity:0.6}
@media(max-width:768px){.side{display:none}.content{margin-left:0;padding:1rem}.cats{grid-template-columns:1fr 1fr}.dash{flex-direction:column}.nav-views{display:none}}
`;
