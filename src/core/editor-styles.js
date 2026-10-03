export const editorStyles = `
#editor{background:#171f21}
#editor .editor-heading{padding-bottom:18px;margin-bottom:18px;gap:20px}
#editor .editor-heading h2{font-size:25px;line-height:1.4;overflow-wrap:anywhere}
#editor .editor-layout{grid-template-columns:minmax(0,1fr) minmax(320px,.95fr);gap:28px}
#editor .editor-preview{border-color:#42544c;box-shadow:0 12px 32px #0003}
#editor .preview-tabs{background:#10181a;padding:5px;border:1px solid var(--line);border-radius:13px;gap:5px}
#editor .preview-tabs button{border-color:transparent;background:transparent;padding:10px 12px;font-weight:600}
#editor .preview-tabs button[aria-pressed=true]{border-color:#638b74;background:#263f32}
#editor .editor-controls{padding-right:12px;scroll-padding-top:68px}
#editor .editor-history{padding:10px 12px;margin-bottom:16px;border:1px solid #36463e;border-radius:12px;background:#1d2925;box-shadow:0 8px 18px #0003}
#editor .editor-history button{font-size:12px;padding:8px 18px}
#editor .editor-controls fieldset{padding:20px;margin-bottom:22px;border-color:#36463e;border-radius:14px;background:#121b1d;min-width:0}
#editor .editor-controls legend{font-size:13px;padding:0 10px;letter-spacing:.1px}
#editor .editor-field{font-size:13px;margin-bottom:22px;gap:12px;line-height:1.6}
#editor .editor-field output{font-variant-numeric:tabular-nums;border:1px solid #3d5b49;padding:3px 9px;min-width:52px;border-radius:20px}
#editor input[type=range]{appearance:none;height:6px;border:0;border-radius:12px;background:#34443b;margin:12px 0 8px;cursor:pointer}
#editor input[type=range]::-webkit-slider-thumb{appearance:none;width:17px;height:17px;border-radius:50%;background:var(--accent);border:2px solid #dcffe9;box-shadow:0 2px 6px #0005}
#editor input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--accent);border:2px solid #dcffe9}
#editor .editor-controls fieldset>small{display:block;margin-top:12px;font-size:12px;line-height:1.75}
#editor .editor-field select{max-width:100%;padding:10px 12px;min-height:42px;border-radius:10px;background:#1d2926}
#editor input[type=color]{width:52px;height:36px;padding:3px;border:1px solid #506358;border-radius:9px;background:#1d2926}
#editor input[type=color]::-webkit-color-swatch-wrapper{padding:0}
#editor input[type=color]::-webkit-color-swatch{border:0;border-radius:5px}
#editor .surface-buttons{padding:4px;background:#1d2926;border:1px solid var(--line);border-radius:11px}
#editor .surface-buttons button{flex:1;padding:9px;border:0;background:transparent}
#editor .surface-buttons button:hover{background:#314438}
#editor .contrast-details{margin:0 0 22px;border:1px solid #6c6240;border-radius:12px;background:#29271b}
#editor .contrast-details summary{padding:14px 16px;cursor:pointer;font-size:12px;color:#e8dba9;line-height:1.6}
#editor .contrast-notice{margin:0;padding:0 16px 16px;border:0;font-size:12px;color:var(--muted)}
#editor .contrast-warning{color:#efd095}
#editor .editor-footer{padding-top:18px;gap:16px;background:#171f21}
#editor .editor-footer .primary{min-width:130px}
#editor .editor-note{font-size:12px}
@media(max-width:850px){#editor .editor-layout{grid-template-columns:1fr;grid-template-rows:minmax(180px,38%) minmax(0,1fr);gap:12px}#editor .editor-controls{padding-right:0}#editor .editor-controls fieldset{padding:16px}#editor .editor-heading h2{font-size:20px}}
`;
