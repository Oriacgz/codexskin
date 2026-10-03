// Shared library and preferences polish; editor styling remains independent.
export const libraryStyles = `
.nav button{color:var(--muted);text-align:left;padding:12px 13px;border-radius:9px;font-weight:550;border:0;background:transparent;width:100%}
.nav button.active{background:#253b31;color:var(--accent)}
.nav button:hover{background:#252d30;color:var(--text)}
.workspace>.preferences{margin-top:0}
.page-intro{margin:0 0 24px;color:var(--muted);font-size:13px;line-height:1.7}
.page-link{display:inline-block;margin-top:20px;color:var(--accent);font-weight:600;text-decoration:none;padding:12px 18px;border:1px solid #40564a;border-radius:10px;background:#20332b}
.page-link:hover{background:#2c4436}
.library-tabs{display:flex;gap:8px;margin:24px 0 0;flex-wrap:wrap}
.library-tabs button{padding:10px 18px;border:1px solid var(--line);border-radius:10px;background:#182023;color:var(--muted);font-weight:600}
.library-tabs button[aria-pressed=true]{background:#263f32;border-color:#638b74;color:var(--accent)}
#noSearchResults{padding:28px;border:1px dashed #40564a;border-radius:13px;color:var(--muted);line-height:1.7;text-align:center}
.installed-themes .section-heading,.preferences .section-heading{margin-bottom:20px}
.installed-themes .section-heading h2,.preferences .section-heading h2{font-size:22px;font-weight:650}
.theme-switcher{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px;background:linear-gradient(120deg,#20332b,#182023);border-color:#40564a}
.theme-switcher>div:first-child{min-width:0;flex:1}
.theme-switcher strong{display:block;overflow-wrap:anywhere;line-height:1.5}
.theme-switcher p{font-size:12px;line-height:1.7;margin:8px 0 0;color:var(--muted)}
.switch-controls{flex-shrink:0;flex-wrap:wrap}
.switch-controls select{max-width:280px}
.grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,310px),1fr));gap:24px}
.preview{height:200px}
.card-content{padding:22px}
.card-heading h3{font-size:16px;line-height:1.5}
.card-content>p{margin-bottom:20px}
.card-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.card-actions button{min-width:0;font-size:12px;padding:10px 8px;white-space:normal;line-height:1.4}
.card-actions .apply-button{grid-column:span 2}
.card-actions .favorite-button{grid-column:span 2}
.card-actions .favorite-button[aria-pressed=true]{color:var(--accent);border-color:#688975;background:#263b31}
.card-actions .remove-button{width:100%;font-size:20px}
.preferences{margin-top:48px}
.preferences>.settings-panel{margin:0 0 20px;overflow:hidden}
.preferences>.settings-panel>h3{padding:24px 24px 0;margin:0;font-size:17px;font-weight:650;line-height:1.5}
.preferences>.settings-panel>p{margin:16px 24px;font-size:12px;line-height:1.75}
.preferences>.settings-panel>button{margin:0 24px 24px}
.preferences>.settings-panel>a{display:inline-block;margin:0 24px 24px;color:var(--accent)}
.preferences .setting{padding:24px;cursor:default}
.preferences label.setting{cursor:pointer}
.preferences .setting>span{min-width:0}
.preferences .setting strong{font-size:14px;font-weight:600}
.preferences .setting small{font-size:12px;margin-top:7px}
.preferences .collection-actions{padding:0 24px 24px}
.preferences .collection-tools .setting:last-child{border-top:1px solid var(--line)}
.schedule-fields{margin:0 24px;padding:20px;background:#11191c;border:1px solid var(--line);border-radius:12px;gap:20px}
.schedule-fields label{font-size:12px;color:var(--muted);font-weight:600;gap:10px}
.schedule-fields input,.schedule-fields select{width:100%;min-width:0;height:44px;padding:10px 12px;background:#1d2926;border:1px solid #42534a;border-radius:9px;color:var(--text);font:inherit;color-scheme:dark}
.schedule-fields input:hover,.schedule-fields select:hover{border-color:#749383}
select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
#scheduleStatus{display:inline-block;border:1px solid #40564a;background:#20332b;border-radius:20px;padding:6px 12px;color:var(--accent);max-width:calc(100% - 48px)}
#saveSchedule{display:block}
#checkUpdates{margin-top:20px}
#updateStatus:empty,.release-notes:empty{display:none}
.release-notes{margin:0 24px 24px;padding:18px;background:#11191c;border:1px solid var(--line);border-radius:10px;font:12px/1.7 inherit}
.restore-row{padding:24px;margin-top:28px;border:1px dashed #405049;border-radius:13px;background:#151c1a}
@media(max-width:1100px){.theme-switcher{align-items:stretch;flex-direction:column;gap:16px}.switch-controls select{max-width:none;flex:1;min-width:0}}
@media(max-width:620px){.schedule-fields{grid-template-columns:1fr;margin:0 18px;padding:16px}.preferences .setting{padding:20px 18px;flex-wrap:wrap}.preferences>.settings-panel>h3{padding:20px 18px 0}.preferences>.settings-panel>p{margin:16px 18px}.preferences>.settings-panel>button{margin-left:18px}.restore-row{align-items:stretch;flex-direction:column}.theme-switcher{padding:20px}.preview{height:180px}}
@media(prefers-reduced-motion:reduce){.theme-card,.primary{transition:none}.theme-card:hover,.primary:hover{transform:none}}
`;
