const fs=require('fs');const path=require('path');
const parts=['1-head.html','2-shell-overview.html','3-scan.html','4-customer.html','5-secrets.html','6-tail.html'];
let html=parts.map(p=>fs.readFileSync(path.join(__dirname,p),'utf8')).join('\n');
const sans=fs.readFileSync(path.join(__dirname,'geist-latin.woff2')).toString('base64');
const mono=fs.readFileSync(path.join(__dirname,'geist-mono-latin.woff2')).toString('base64');
const fonts='/* Geist and Geist Mono (SIL OFL 1.1), latin subset, embedded so the mock makes zero requests. The app self-hosts the same files via next/font/local. */\n'+
`@font-face{font-family:"Geist";src:url(data:font/woff2;base64,${sans}) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}\n`+
`@font-face{font-family:"Geist Mono";src:url(data:font/woff2;base64,${mono}) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`;
html=html.replace('/*FONTS*/',fonts);
const KINDS=['blocker','high','medium','low','pass','notrun','failed'];
html=html.replace(/\{\{m:([a-z]+)\}\}/g,(m,k)=>{if(!KINDS.includes(k))throw new Error('bad mark '+k);return `<svg class="mk mk-${k}" aria-hidden="true" focusable="false"><use href="#m-${k}"/></svg>`;});
if(/\{\{/.test(html))throw new Error('unexpanded placeholder');
const out=path.join(__dirname,'..','mock-final.html');
fs.writeFileSync(out,html);
console.log('wrote',out,html.length,'bytes');
