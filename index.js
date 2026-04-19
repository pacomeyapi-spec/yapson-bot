const express = require('express');
const fetch   = require('node-fetch');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ═══════════════════════════════════════════
   COMPTES — stockés en mémoire, modifiables
   depuis le dashboard sans redéploiement
═══════════════════════════════════════════ */
const accounts = {
  yapson: {
    url:      process.env.YAPSON_URL  || 'https://sms-mirror-production.up.railway.app',
    username: process.env.YAPSON_USER || '',
    password: process.env.YAPSON_PASS || '',
    token:    '',   /* rempli automatiquement après login */
  },
  mgmt: {
    url:      process.env.MGMT_URL  || 'https://my-managment.com',
    username: process.env.MGMT_USER || '',
    password: process.env.MGMT_PASS || '',
    cookies:  [],   /* cookies de session injectés depuis le dashboard */
  },
};

/* ═══════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════ */
const CFG = {
  FONCTION:    process.env.FONCTION      || 'F1',
  SENDERS:     process.env.SENDERS       || 'Wave Business,+454,MobileMoney,MoovMoney',
  INTERVAL:    parseInt(process.env.INTERVAL_SEC || '15'),
  F2_CONF_MIN: parseInt(process.env.F2_CONF_MIN  || '10'),
  F2_REJ_ON:   process.env.F2_REJ_ON === 'true',
  F2_REJ_MIN:  parseInt(process.env.F2_REJ_MIN   || '15'),
  PORT:        parseInt(process.env.PORT || '3000'),
};

/* ═══════════════════════════════════════════
   ÉTAT
═══════════════════════════════════════════ */
let browser=null, page=null;
let running=false, loopTimer=null;
let status='stopped';
let lastTs=Date.now();
const seen=new Set(), rejectedDates=new Set(), confirmedPhones=new Set();
const ST={ok:0,miss:0,fix:0,polls:0,sms:0,rej:0};
const logs=[];
let resolve2FA=null;

function log(msg, level='INFO') {
  const e={ts:new Date().toISOString(),level,msg:String(msg)};
  logs.unshift(e); if(logs.length>500) logs.pop();
  console.log(`[${level}] ${msg}`);
}

/* ═══════════════════════════════════════════
   LOGIN YAPSONPRESS (via API REST)
═══════════════════════════════════════════ */
async function loginYapson() {
  const {url,username,password} = accounts.yapson;
  if(!username||!password) { log('⚠️ YAPSON_USER ou YAPSON_PASS manquant','WARN'); return false; }
  log(`Connexion YapsonPress (${username})…`);
  try {
    const r = await fetch(`${url}/api/login`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username,password})
    });
    const data = await r.json();
    if(!r.ok || !data.token) {
      log(`❌ Login YapsonPress échoué: ${data.error||r.status}`,'ERROR');
      return false;
    }
    accounts.yapson.token = data.token;
    log(`✅ YapsonPress connecté (${username})`,'OK');
    return true;
  } catch(e) {
    log(`❌ Erreur login YapsonPress: ${e.message}`,'ERROR');
    return false;
  }
}

/* ═══════════════════════════════════════════
   API YAPSONPRESS
═══════════════════════════════════════════ */
async function apiFetch(sender) {
  /* Si token expiré, se reconnecter automatiquement */
  const doFetch = async () => fetch(
    `${accounts.yapson.url}/api/messages?sender=${encodeURIComponent(sender)}&limit=500`,
    { headers:{ Authorization:`Bearer ${accounts.yapson.token}` } }
  );
  let r = await doFetch();
  if(r.status===401) {
    log('Token YapsonPress expiré — reconnexion…','WARN');
    await loginYapson();
    r = await doFetch();
  }
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}

async function apiApprove(id) {
  const doApprove = async () => fetch(
    `${accounts.yapson.url}/api/messages/${encodeURIComponent(id)}/status`,
    { method:'PATCH',
      headers:{ Authorization:`Bearer ${accounts.yapson.token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({status:'approuve'}) }
  );
  let r = await doApprove();
  if(r.status===401) { await loginYapson(); r = await doApprove(); }
  return r.ok;
}

/* ═══════════════════════════════════════════
   PARSEURS
═══════════════════════════════════════════ */
const na = s => (s==null?'':String(s)).trim().replace(/[\s\u00a0]/g,'');
function normPhone(s){const d=s.replace(/[^0-9]/g,'');if(d.length===13&&d.slice(0,4)==='2250')return d.slice(3);if(d.length===12&&d.slice(0,3)==='225')return '0'+d.slice(3);return d;}
function parseAmt(raw){if(!raw)return 0;let s=na(raw);if(/^[0-9]+\.[0-9]{3}$/.test(s))return parseInt(s.replace('.',''));if(/^[0-9]+,[0-9]{3}$/.test(s))return parseInt(s.replace(',',''));return Math.floor(parseFloat(s.replace(',','.')))||0;}
function parseSMS(sender,content){
  if(!content||typeof content!=='string')return null;
  let m;
  if(sender==='Wave Business'){m=content.match(/\((0[0-9]{9})\)\s+a\s+pay[eé]\s+([0-9.,\s\u00a0]+)F/i);if(!m)return null;const a=parseAmt(m[2]);return a>0?{phone:m[1],amount:a}:null;}
  if(sender==='MobileMoney'){m=content.match(/re[çc]u\s+([0-9\s\u00a0]+)\s*FCFA\s+du\s+([+0-9\s]+)/i);if(!m)return null;const ph=normPhone(m[2].trim()),a=parseInt(m[1].replace(/[\s\u00a0]/g,''));return /^0[0-9]{9}$/.test(ph)&&a>0?{phone:ph,amount:a}:null;}
  if(sender==='MoovMoney'){m=content.match(/Le\s+num[eé]ro\s+([+0-9\s]+)\s+a\s+envoy[eé]\s+([0-9\s\u00a0]+)\s*FCFA/i);if(!m)return null;const ph=normPhone(m[1].trim()),a=parseInt(m[2].replace(/[\s\u00a0]/g,''));return /^0[0-9]{9}$/.test(ph)&&a>0?{phone:ph,amount:a}:null;}
  if(sender==='+454'){m=content.match(/transfert\s+de\s+([0-9.,\s\u00a0]+)\s*FCFA\s+du\s+(0[0-9]{9})/i);if(!m)return null;const a=parseAmt(m[1]);return a>0?{phone:m[2],amount:a}:null;}
  return null;
}
function fmtAmt(n){if(n<1000)return String(n);const s=String(n),r=s.length%3,pp=[];if(r)pp.push(s.slice(0,r));for(let i=r;i<s.length;i+=3)pp.push(s.slice(i,i+3));return pp.join('\u00a0');}
function parseProcTime(text){if(!text)return 0;let t=0;const h=text.match(/([0-9]+)\s*heure/),m=text.match(/([0-9]+)\s*minute/);if(h)t+=parseInt(h[1])*60;if(m)t+=parseInt(m[1]);if(text.includes('less than')||text.includes('moins'))t=0;return t;}

/* ═══════════════════════════════════════════
   NAVIGATEUR — connexion my-managment
═══════════════════════════════════════════ */
async function initBrowser(){
  if(browser){try{await browser.close();}catch(_){}}
  log('Lancement navigateur…');
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  page=await browser.newPage();
  await page.setViewportSize({width:1280,height:800});
  log('Navigateur prêt');
}

async function loginMgmt(){
  const {url}=accounts.mgmt;
  status='connecting';

  /* ── Si des cookies sont disponibles, les utiliser directement ── */
  if(accounts.mgmt.cookies && accounts.mgmt.cookies.length>0){
    log(`Injection de ${accounts.mgmt.cookies.length} cookie(s) my-managment…`);
    try{
      /* Aller sur le domaine pour pouvoir injecter les cookies */
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
      await page.context().addCookies(accounts.mgmt.cookies);
      /* Naviguer directement vers la page admin */
      await page.goto(`${url}/fr/admin/report/pendingrequestrefill`,{waitUntil:'domcontentloaded',timeout:20000});
      if(!page.url().includes('signin')){
        log('✅ my-managment connecté via cookies','OK');
        status='running'; return true;
      }
      /* Cookies expirés → demander de nouveaux cookies */
      log('⚠️ Cookies expirés — nouveaux cookies requis','WARN');
      accounts.mgmt.cookies = []; /* Vider les anciens cookies */
    }catch(e){ log('⚠️ Erreur cookies: '+e.message,'WARN'); }
    status='waiting_cookies'; return false;
  }

  /* ── Pas de cookies → essayer le login formulaire ── */
  const {username,password}=accounts.mgmt;
  if(!username||!password){
    log('❌ Pas de cookies ni identifiants — injecte tes cookies depuis le dashboard','WARN');
    status='waiting_cookies'; return false;
  }
  log(`Connexion my-managment formulaire (${username})…`);
  try{
    await page.goto(`${url}/signin/`,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(1000);
    await page.fill('input[placeholder*="utilisateur"],input[type="text"]:not([placeholder*="iltr"])',username);
    await page.fill('input[type="password"]',password);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
    /* 2FA requis ? */
    const codeInput=await page.$('input[placeholder*="confirmation"],input[placeholder*="code"],input[placeholder*="Code"]');
    if(codeInput){
      log('Code 2FA requis — en attente…','WARN');
      status='waiting_2fa';
      const code=await new Promise(resolve=>{
        resolve2FA=resolve;
        setTimeout(()=>{if(resolve2FA){resolve2FA(null);resolve2FA=null;}},300000);
      });
      if(!code){log('2FA timeout','ERROR');status='waiting_cookies';return false;}
      await page.fill('input[placeholder*="confirmation"],input[placeholder*="code"],input[placeholder*="Code"]',code);
      await page.click('button[type="submit"],button.btn-primary');
      await page.waitForTimeout(3000);
    }
    if(page.url().includes('signin')){
      log('❌ Login formulaire échoué (reCAPTCHA) — injecte tes cookies','WARN');
      status='waiting_cookies'; return false;
    }
    /* Succès login formulaire → sauvegarder les cookies */
    const saved = await page.context().cookies();
    accounts.mgmt.cookies = saved.filter(c=>c.domain.includes('my-managment'));
    log(`✅ my-managment connecté, ${accounts.mgmt.cookies.length} cookie(s) sauvegardés`,'OK');
    status='running'; return true;
  }catch(e){
    log('❌ Erreur login: '+e.message,'ERROR');
    status='waiting_cookies'; return false;
  }
}

async function checkSession(){
  try{
    await page.goto(`${accounts.mgmt.url}/fr/admin/report/pendingrequestrefill`,{waitUntil:'domcontentloaded',timeout:20000});
    if(page.url().includes('signin')){
      log('Session expirée — cookies requis','WARN');
      accounts.mgmt.cookies=[]; /* Vider les cookies expirés */
      status='waiting_cookies';
      return false;
    }
    return true;
  }catch(e){
    log('Erreur navigation: '+e.message,'ERROR');
    return false;
  }
}

/* ═══════════════════════════════════════════
   TABLEAU
═══════════════════════════════════════════ */
async function setupTable(){
  const tog=await page.$('.apm-form__switch');
  let wasOn=false;
  if(tog){const txt=await tog.textContent();wasOn=txt.includes('ON');if(wasOn){await tog.click();await page.waitForTimeout(600);}}
  for(const m of await page.$$('.multiselect')){
    const s=await m.$('.multiselect__single');if(!s)continue;
    const v=(await s.textContent()).trim();
    if(['100','50','25'].includes(v)){
      await m.$eval('.multiselect__select',el=>el.click());await page.waitForTimeout(400);
      for(const o of await m.$$('.multiselect__option'))
        if((await o.textContent()).trim()==='500'){await o.click();await page.waitForTimeout(300);break;}
      break;
    }
  }
  for(const b of await page.$$('button'))
    if(/appliquer/i.test(await b.textContent())){await b.click();await page.waitForTimeout(3000);break;}
  return wasOn;
}
async function restoreTable(wasOn){
  if(!wasOn)return;
  const tog=await page.$('.apm-form__switch');
  if(tog&&(await tog.textContent()).includes('OFF')){await tog.click();await page.waitForTimeout(400);}
}

/* ═══════════════════════════════════════════
   CONFIRMATION
═══════════════════════════════════════════ */
async function confirmDeposit(phone,amount){
  const rows=await page.$$('table tbody tr');
  let targetRow=null,needFix=false,siteAmt='?';
  const amtStr=na(String(amount));
  for(const row of rows){
    let pf=false,af=false;
    for(const c of await row.$$('td')){const t=na(await c.textContent());if(t.includes(phone))pf=true;if(t===amtStr)af=true;}
    if(pf&&af){targetRow=row;needFix=false;break;}
    if(pf&&!targetRow){targetRow=row;needFix=true;}
  }
  if(!targetRow){log('❌ INTROUVABLE: '+phone,'ERROR');ST.miss++;return false;}
  if(needFix){for(const c of await targetRow.$$('td')){const t=na(await c.textContent());if(/^[0-9]+$/.test(t)&&parseInt(t)>0){siteAmt=t;break;}}log(`⚠️ Montant diff: ${phone} SMS:${fmtAmt(amount)} Site:${siteAmt}`,'WARN');}
  let link=null;
  for(const a of await targetRow.$$('a'))if((await a.textContent()).trim()==='Confirmer'){link=a;break;}
  if(!link){log('❌ Lien Confirmer manquant: '+phone,'ERROR');return false;}
  await link.click();await page.waitForTimeout(800);
  let modalBtn=null;
  for(let i=0;i<30;i++){
    for(const b of await page.$$('button')){const t=(await b.textContent()).trim().toUpperCase();const box=await b.boundingBox();if(t==='CONFIRMER'&&box&&box.width>100){modalBtn=b;break;}}
    if(modalBtn)break;await page.waitForTimeout(300);
  }
  if(!modalBtn){log('❌ Modale non trouvée: '+phone,'ERROR');return false;}
  if(needFix){
    const mi=await page.$('input[placeholder="Montant"],input[placeholder="montant"]');
    if(mi){await mi.fill('');await mi.fill(String(amount));await page.waitForTimeout(200);}
    const ci=await page.$('input[placeholder="Commentaire"],textarea[placeholder="Commentaire"]');
    if(ci){await ci.fill('');await ci.fill(String(amount));await page.waitForTimeout(200);}
    ST.fix++;
  }
  await modalBtn.click();
  for(let i=0;i<30;i++){let f=false;for(const b of await page.$$('button'))if((await b.textContent()).trim().toUpperCase()==='CONFIRMER'){f=true;break;}if(!f)break;await page.waitForTimeout(300);}
  await page.waitForTimeout(1500);
  log(`✅ Confirmé: ${phone} — ${fmtAmt(amount)}${needFix?' ✏️':''}`,'OK');
  ST.ok++;return true;
}

/* ═══════════════════════════════════════════
   REJET
═══════════════════════════════════════════ */
async function rejectDeposit(date,time){
  let targetRow=null;
  for(const row of await page.$$('table tbody tr')){
    const cells=await row.$$('td');
    if(cells.length>0&&(await cells[0].textContent()).trim()===date){targetRow=row;break;}
  }
  if(!targetRow)return false;
  let rejectLink=null;
  for(const a of await targetRow.$$('a'))if((await a.textContent()).trim()==='Rejeter'){rejectLink=a;break;}
  if(!rejectLink)return false;
  await rejectLink.click();
  let okBtn=null;
  for(let i=0;i<40;i++){
    for(const b of await page.$$('button,a.btn,.btn'))if((await b.textContent()).trim()==='OK'&&await b.isVisible()){okBtn=b;break;}
    if(okBtn)break;await page.waitForTimeout(200);
  }
  if(!okBtn)return false;
  await page.waitForTimeout(300);
  const ci=await page.$('input[placeholder="Commentaire"],textarea[placeholder="Commentaire"]');
  if(ci){await ci.fill('Expiré');await page.waitForTimeout(200);}
  for(const b of await page.$$('button,a.btn,.btn'))if((await b.textContent()).trim()==='OK'&&await b.isVisible()){await b.click();break;}
  await page.waitForTimeout(2000);
  rejectedDates.add(date);
  log(`🗑 Rejeté: ${date} (${time} min)`,'WARN');
  ST.rej++;return true;
}

/* ═══════════════════════════════════════════
   F1
═══════════════════════════════════════════ */
async function pollF1(){
  const senders=CFG.SENDERS.split(',').map(s=>s.trim());
  const fresh=[];
  for(const s of senders){
    try{
      const msgs=await apiFetch(s);
      for(const msg of msgs){
        if(msg.timestamp<lastTs||seen.has(msg.id)||msg.status==='pas_de_commande'||msg.status==='approuve')continue;
        const p=parseSMS(s,msg.content);
        if(p&&p.amount>0)fresh.push({id:msg.id,phone:p.phone,amount:p.amount,ts:msg.timestamp});
      }
    }catch(e){log(`⚠️ ${s}: ${e.message}`,'WARN');}
  }
  if(!fresh.length){log('RAS');return;}
  log(`🆕 ${fresh.length} nouveau(x) SMS`);
  ST.sms+=fresh.length;
  for(const p of fresh){await apiApprove(p.id);seen.add(p.id);log(`Approuvé YapsonPress: ${p.phone} — ${p.amount}F`);}
  const mx=Math.max(...fresh.map(p=>p.ts||0));
  if(mx>=lastTs)lastTs=mx+1;
  const ok=await checkSession();if(!ok)return;
  const wasOn=await setupTable();
  for(const p of fresh)await confirmDeposit(p.phone,p.amount);
  await restoreTable(wasOn);
}

/* ═══════════════════════════════════════════
   F2
═══════════════════════════════════════════ */
async function findPhone(phone){
  const senders=CFG.SENDERS.split(',').map(s=>s.trim());
  const suffix=phone.replace(/[^0-9]/g,'').slice(-9);
  for(const s of senders){
    try{
      const msgs=await apiFetch(s);
      for(const msg of msgs){
        if(msg.status==='approuve'||msg.status==='pas_de_commande')continue;
        const p=parseSMS(s,msg.content);
        if(!p)continue;
        if(p.phone.replace(/[^0-9]/g,'').slice(-9)===suffix)return{id:msg.id,phone:p.phone,amount:p.amount};
      }
    }catch(e){}
  }
  return null;
}

async function pollF2(){
  const ok=await checkSession();if(!ok)return;
  const wasOn=await setupTable();
  const rows=await page.$$('table tbody tr');
  let nbConf=0,nbRej=0;
  /* Debug : logger les premières lignes pour vérifier la structure */
  if(rows.length>0&&ST.polls<=5){
    log(`F2 debug: ${rows.length} ligne(s) trouvée(s) dans le tableau`);
    for(let i=0;i<Math.min(3,rows.length);i++){
      const cells=await rows[i].$$('td');
      const cellTexts=[];
      for(const c of cells) cellTexts.push((await c.textContent()).trim().substring(0,30));
      log(`F2 ligne[${i}] (${cells.length} cols): ${cellTexts.join(' | ')}`);
    }
  } else if(rows.length===0&&ST.polls<=5){
    /* Pas de tbody tr — essayer d'autres sélecteurs */
    const allRows=await page.$$('tr');
    log(`F2 debug: 0 tbody tr, ${allRows.length} tr total`);
    const html=(await page.content()).substring(0,500);
    log('F2 page snippet: '+html.replace(/\s+/g,' '));
  }
  for(const row of rows){
    const cells=await row.$$('td');if(cells.length<3)continue;
    const date=(await cells[0].textContent()).trim();
    const info=(await cells[1].textContent()).trim();
    /* Le temps peut être dans différentes colonnes selon le tableau */
    let time=0;
    for(let ci=cells.length-1;ci>=2;ci--){
      const t=(await cells[ci].textContent()).trim();
      const parsed=parseProcTime(t);
      if(parsed>0){time=parsed;break;}
    }
    if(!date||confirmedPhones.has(date)||rejectedDates.has(date))continue;
    const phoneMatch=info.match(/0[0-9]{9}/);if(!phoneMatch)continue;
    const phone=phoneMatch[0];
    if(time<CFG.F2_CONF_MIN)continue;
    log(`🔍 ${phone} — ${time} min`);
    const found=await findPhone(phone);
    if(found){
      await apiApprove(found.id);log(`Approuvé YapsonPress: ${phone} — ${found.amount}F`);ST.sms++;
      const confirmed=await confirmDeposit(phone,found.amount);
      if(confirmed){confirmedPhones.add(date);nbConf++;}
    }else if(CFG.F2_REJ_ON&&time>=CFG.F2_REJ_MIN){
      log(`${phone} absent (${time} min) → rejet`);
      if(await rejectDeposit(date,time))nbRej++;
    }
  }
  await restoreTable(wasOn);
  log(`Poll F2: ${nbConf} confirmé(s), ${nbRej} rejeté(s)`);
}

/* ═══════════════════════════════════════════
   BOUCLE
═══════════════════════════════════════════ */
async function startBot(){
  log(`🚀 YapsonBot — Fonction:${CFG.FONCTION} Intervalle:${CFG.INTERVAL}s`);
  /* 1. Login YapsonPress */
  const ypOk=await loginYapson();
  if(!ypOk){log('❌ Impossible de se connecter à YapsonPress','ERROR');status='error';return;}
  /* 2. Init navigateur + login my-managment */
  await initBrowser();
  const mgmtOk=await loginMgmt();
  if(!mgmtOk){
    log('⚠️ Connexion my-managment échouée — injecte tes cookies depuis le dashboard','WARN');
    status='waiting_cookies';
    return; /* Le serveur HTTP reste actif pour recevoir les cookies */
  }
  running=true;
  async function loop(){
    if(!running)return;
    ST.polls++;
    try{if(CFG.FONCTION==='F1')await pollF1();else await pollF2();}
    catch(e){
      log('Erreur poll: '+e.message,'ERROR');
      try{await page.reload({timeout:10000});}catch(_){try{await initBrowser();await loginMgmt();}catch(__){}}
    }
    if(running)loopTimer=setTimeout(loop,CFG.INTERVAL*1000);
  }
  loop();
}

/* ═══════════════════════════════════════════
   DASHBOARD — HTML
═══════════════════════════════════════════ */
const SL={stopped:'⏹ Arrêté',connecting:'🔄 Connexion…',waiting_2fa:'📱 Code 2FA requis',waiting_cookies:'🍪 Cookies requis',running:'🟢 Actif',error:'❌ Erreur'};
const SC={stopped:'#475569',connecting:'#38bdf8',waiting_2fa:'#f9e2af',waiting_cookies:'#a78bfa',running:'#4ade80',error:'#f38ba8'};

function dashboardHTML(){
  const needs2fa=(status==='waiting_2fa');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>YapsonBot</title>
${!needs2fa?'<meta http-equiv="refresh" content="10">':''}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:monospace;background:#0f1117;color:#e2e8f0;padding:20px;max-width:960px;margin:0 auto}
h1{color:#38bdf8;font-size:1.2rem;font-weight:800;margin-bottom:14px;display:flex;align-items:center;gap:10px}
.badge{font-size:.72rem;padding:3px 10px;border-radius:20px;background:#1e2433}
section{background:#161b27;border:1px solid #1e2433;border-radius:8px;padding:14px;margin-bottom:14px}
section h2{font-size:.7rem;color:#cba6f7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.field label{display:block;font-size:.62rem;color:#475569;text-transform:uppercase;margin-bottom:3px}
.field input,.field select{width:100%;background:#0a0e18;border:1px solid #1e2433;border-radius:5px;color:#e2e8f0;padding:7px 10px;font-family:monospace;font-size:.78rem;outline:none}
.field input:focus,.field select:focus{border-color:#38bdf8}
.field input[type=password]{letter-spacing:2px}
.btn{padding:8px 16px;border:none;border-radius:6px;font-size:.75rem;font-weight:700;cursor:pointer;font-family:monospace}
.btn-blue{background:#38bdf8;color:#0f1117}
.btn-green{background:#4ade80;color:#0f1117}
.btn-red{background:#f38ba8;color:#0f1117}
.btn-orange{background:#f9e2af;color:#0f1117}
.btn-ghost{background:#1e2433;color:#e2e8f0}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.stat{background:#161b27;border:1px solid #1e2433;border-radius:8px;padding:10px 14px;text-align:center;min-width:75px}
.stat .n{font-size:1.3rem;font-weight:800;display:block}
.stat .l{font-size:.6rem;color:#475569;margin-top:2px}
.g{color:#4ade80}.r{color:#f87171}.o{color:#fb923c}.b{color:#38bdf8}.p{color:#cba6f7}.w{color:#fb923c}
.logs{background:#0a0e18;border:1px solid #1e2433;border-radius:8px;padding:10px;max-height:50vh;overflow-y:auto}
.ll{font-size:.68rem;padding:2px 0;border-bottom:1px solid #0d1117;display:flex;gap:8px}
.ll .t{color:#313244;flex-shrink:0;width:160px;font-size:.63rem}
.OK .m{color:#4ade80}.ERROR .m{color:#f38ba8}.WARN .m{color:#fb923c}.INFO .m{color:#6c7086}
.box2fa{background:#1c1400;border:2px solid #f9e2af;border-radius:8px;padding:14px;margin-bottom:14px}
.box2fa h3{color:#f9e2af;margin-bottom:8px}
.box2fa input{background:#0a0e18;border:2px solid #f9e2af;border-radius:6px;color:#f9e2af;padding:8px 12px;font-family:monospace;font-size:1rem;letter-spacing:4px;width:160px;text-align:center;outline:none}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.irow{display:flex;align-items:center;gap:8px;font-size:.78rem;color:#94a3b8}
.irow input[type=number]{width:65px;text-align:center;background:#0a0e18;border:1px solid #1e2433;border-radius:4px;color:#e2e8f0;padding:5px;font-family:monospace;outline:none}
.chk{display:flex;align-items:center;gap:6px;font-size:.78rem;color:#94a3b8;cursor:pointer}
</style>
</head>
<body>
<h1>🔍 YapsonBot
  <span class="badge" style="color:${SC[status]||'#e2e8f0'}">${SL[status]||status}</span>
</h1>

${status==='waiting_cookies'?`
<div class="box2fa" style="border-color:#a78bfa;background:#110a1c;">
  <h3 style="color:#a78bfa;">🍪 Cookies my-managment requis</h3>
  <p style="font-size:.75rem;color:#94a3b8;margin-bottom:12px;line-height:1.6">
    my-managment utilise un reCAPTCHA qui bloque le login automatique.<br>
    <b style="color:#cba6f7;">Comment obtenir tes cookies :</b><br>
    1. Connecte-toi sur <b>my-managment.com</b> dans ton navigateur<br>
    2. Appuie sur <b>F12</b> → onglet <b>Application</b> → <b>Cookies</b> → <b>my-managment.com</b><br>
    3. Clique droit sur les cookies → <b>Copy all as JSON</b><br>
    &nbsp;&nbsp;&nbsp;<i>ou utilise l'extension "EditThisCookie" → Exporter</i><br>
    4. Colle le JSON ci-dessous et clique <b>Injecter</b>
  </p>
  <form action="/set-cookies" method="POST">
    <textarea name="cookies_json" placeholder='[{"name":"session","value":"...","domain":".my-managment.com",...}]'
      style="width:100%;background:#0a0e18;border:2px solid #a78bfa;border-radius:6px;color:#cba6f7;
      padding:10px;font-family:monospace;font-size:.7rem;height:120px;resize:vertical;outline:none;
      box-sizing:border-box;margin-bottom:8px;"></textarea>
    <button type="submit" class="btn" style="background:#a78bfa;color:#0f1117;font-weight:700;padding:9px 20px;border-radius:6px;border:none;cursor:pointer;font-family:monospace;">
      🍪 Injecter les cookies
    </button>
  </form>
</div>`:''}
${needs2fa?`
<div class="box2fa">
  <h3>📱 Code 2FA requis</h3>
  <p style="font-size:.75rem;color:#94a3b8;margin-bottom:10px;line-height:1.6">
    my-managment demande le code SMS reçu sur ton téléphone.</p>
  <form action="/reconnect" method="POST">
    <div class="row">
      <input type="text" name="code" maxlength="6" placeholder="_ _ _ _ _ _" inputmode="numeric" autofocus>
      <button type="submit" class="btn btn-orange">✅ Valider</button>
    </div>
  </form>
</div>`:''}

<!-- STATISTIQUES -->
<div class="stats">
  <div class="stat"><span class="n g">${ST.ok}</span><span class="l">Confirmés</span></div>
  <div class="stat"><span class="n r">${ST.miss}</span><span class="l">Manquants</span></div>
  <div class="stat"><span class="n o">${ST.fix}</span><span class="l">Corrigés</span></div>
  <div class="stat"><span class="n b">${ST.polls}</span><span class="l">Polls</span></div>
  <div class="stat"><span class="n p">${ST.sms}</span><span class="l">SMS</span></div>
  <div class="stat"><span class="n w">${ST.rej}</span><span class="l">Rejetés</span></div>
</div>

<!-- COMPTES -->
<section>
  <h2>🔑 Comptes</h2>
  <div class="grid2">
    <div>
      <p style="font-size:.72rem;color:#38bdf8;margin-bottom:8px;font-weight:700">YapsonPress</p>
      <form action="/update-account" method="POST">
        <input type="hidden" name="target" value="yapson">
        <div class="field" style="margin-bottom:6px"><label>URL</label><input name="url" value="${accounts.yapson.url}"></div>
        <div class="field" style="margin-bottom:6px"><label>Identifiant</label><input name="username" value="${accounts.yapson.username}"></div>
        <div class="field" style="margin-bottom:6px"><label>Mot de passe</label><input type="password" name="password" value="${accounts.yapson.password}"></div>
        <button type="submit" class="btn btn-blue">💾 Sauvegarder</button>
      </form>
    </div>
    <div>
      <p style="font-size:.72rem;color:#4ade80;margin-bottom:8px;font-weight:700">my-managment</p>
      <form action="/update-account" method="POST">
        <input type="hidden" name="target" value="mgmt">
        <div class="field" style="margin-bottom:6px"><label>URL</label><input name="url" value="${accounts.mgmt.url}"></div>
        <div class="field" style="margin-bottom:6px"><label>Identifiant</label><input name="username" value="${accounts.mgmt.username}"></div>
        <div class="field" style="margin-bottom:6px"><label>Mot de passe</label><input type="password" name="password" value="${accounts.mgmt.password}"></div>
        <button type="submit" class="btn btn-blue">💾 Sauvegarder</button>
      </form>
    </div>
  </div>
</section>

<!-- CONFIG -->
<section>
  <h2>⚙️ Configuration</h2>
  <form action="/update-config" method="POST">
    <div class="grid2" style="margin-bottom:10px">
      <div class="field">
        <label>Fonction</label>
        <select name="fonction">
          <option value="F1" ${CFG.FONCTION==='F1'?'selected':''}>📲 F1 — SMS entrants</option>
          <option value="F2" ${CFG.FONCTION==='F2'?'selected':''}>🕐 F2 — Tableau</option>
        </select>
      </div>
      <div class="field">
        <label>Expéditeurs (séparés par virgule)</label>
        <input name="senders" value="${CFG.SENDERS}">
      </div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <div class="irow"><span>Intervalle:</span><input type="number" name="interval" value="${CFG.INTERVAL}" min="5" max="300"><span>s</span></div>
      <div class="irow"><span>F2 Confirmer ≥</span><input type="number" name="f2_conf" value="${CFG.F2_CONF_MIN}" min="1"><span>min</span></div>
      <label class="chk"><input type="checkbox" name="f2_rej_on" ${CFG.F2_REJ_ON?'checked':''}> Rejet auto</label>
      <div class="irow"><span>≥</span><input type="number" name="f2_rej" value="${CFG.F2_REJ_MIN}" min="1"><span>min</span></div>
    </div>
    <button type="submit" class="btn btn-blue">💾 Appliquer</button>
  </form>
</section>

<!-- CONTRÔLES -->
<section>
  <h2>▶ Contrôles</h2>
  <div class="row">
    ${!running?`<form action="/start" method="POST"><button type="submit" class="btn btn-green">▶ Démarrer</button></form>`:''}
    ${running?`<form action="/stop" method="POST"><button type="submit" class="btn btn-red">⏹ Arrêter</button></form>`:''}
    <form action="/reset" method="POST"><button type="submit" class="btn btn-ghost">⟳ Reset stats</button></form>
  </div>
</section>

<!-- LOGS -->
<div class="logs">
${logs.map(l=>`<div class="ll ${l.level}"><span class="t">${l.ts.replace('T',' ').substring(0,19)}</span><span class="m">${l.msg.replace(/</g,'&lt;')}</span></div>`).join('')}
</div>
</body></html>`;
}

/* ═══════════════════════════════════════════
   ROUTES
═══════════════════════════════════════════ */
app.get('/', (req,res) => res.send(dashboardHTML()));

/* Mise à jour compte */
app.post('/update-account', (req,res) => {
  const {target,url,username,password}=req.body;
  if(target==='yapson'){
    if(url)     accounts.yapson.url=url.trim();
    if(username)accounts.yapson.username=username.trim();
    if(password)accounts.yapson.password=password.trim();
    accounts.yapson.token=''; /* forcer un nouveau login */
    log(`Compte YapsonPress mis à jour (${accounts.yapson.username})`);
  } else if(target==='mgmt'){
    if(url)     accounts.mgmt.url=url.trim();
    if(username)accounts.mgmt.username=username.trim();
    if(password)accounts.mgmt.password=password.trim();
    log(`Compte my-managment mis à jour (${accounts.mgmt.username})`);
  }
  res.redirect('/');
});

/* Mise à jour config */
app.post('/update-config', (req,res) => {
  const b=req.body;
  if(b.fonction)  CFG.FONCTION=b.fonction;
  if(b.senders)   CFG.SENDERS=b.senders;
  if(b.interval)  CFG.INTERVAL=parseInt(b.interval)||15;
  if(b.f2_conf)   CFG.F2_CONF_MIN=parseInt(b.f2_conf)||10;
  CFG.F2_REJ_ON = b.f2_rej_on==='on';
  if(b.f2_rej)    CFG.F2_REJ_MIN=parseInt(b.f2_rej)||15;
  log(`Config mise à jour — Fonction:${CFG.FONCTION} Interval:${CFG.INTERVAL}s`);
  /* Redémarrer la boucle si active */
  if(running && loopTimer){clearTimeout(loopTimer);loopTimer=null;log('Boucle redémarrée avec nouvelle config');}
  res.redirect('/');
});

/* 2FA */
app.post('/reconnect', (req,res) => {
  const code=(req.body.code||'').trim();
  if(code&&resolve2FA){log(`Code 2FA reçu`);resolve2FA(code);resolve2FA=null;}
  res.redirect('/');
});

/* Démarrer / Arrêter */
app.post('/start', (req,res) => {
  if(!running) startBot().catch(e=>log('Erreur démarrage: '+e.message,'ERROR'));
  res.redirect('/');
});
app.post('/stop', (req,res) => {
  running=false;
  if(loopTimer){clearTimeout(loopTimer);loopTimer=null;}
  status='stopped';
  log('⏹ Arrêté manuellement');
  res.redirect('/');
});
app.post('/reset', (req,res) => {
  seen.clear();rejectedDates.clear();confirmedPhones.clear();
  lastTs=Date.now();
  Object.keys(ST).forEach(k=>ST[k]=0);
  log('🔄 Stats réinitialisées');
  res.redirect('/');
});

/* Injecter les cookies my-managment */
app.post('/set-cookies', async (req,res) => {
  const raw = (req.body.cookies_json||'').trim();
  if(!raw){ res.redirect('/'); return; }
  try{
    const cookies = JSON.parse(raw);
    if(!Array.isArray(cookies)||cookies.length===0) throw new Error('Format invalide');
    /* Normaliser sameSite pour Playwright (Strict|Lax|None uniquement) */
    const normSameSite = v => {
      if(!v) return 'Lax';
      const s = String(v).toLowerCase();
      if(s==='strict') return 'Strict';
      if(s==='none' || s==='no_restriction') return 'None';
      return 'Lax'; /* défaut pour lax, unspecified, etc. */
    };
    accounts.mgmt.cookies = cookies.map(c=>({
      name:    c.name,
      value:   c.value,
      domain:  c.domain || 'my-managment.com',
      path:    c.path   || '/',
      secure:  c.secure  || false,
      httpOnly:c.httpOnly|| false,
      sameSite:normSameSite(c.sameSite),
    }));
    log(`🍪 ${accounts.mgmt.cookies.length} cookie(s) injectés`,'OK');
    status='stopped';
    if(running){ running=false; if(loopTimer){clearTimeout(loopTimer);loopTimer=null;} }
    startBot().catch(e=>{ log('Erreur redémarrage: '+e.message,'ERROR'); status='waiting_cookies'; });
    res.redirect('/');
  }catch(e){
    log('❌ Cookies invalides: '+e.message,'ERROR');
    res.redirect('/');
  }
});

/* API JSON */
app.get('/api/status', (req,res) => res.json({status,ST,accounts:{yapson:{url:accounts.yapson.url,username:accounts.yapson.username},mgmt:{url:accounts.mgmt.url,username:accounts.mgmt.username}},CFG}));
app.get('/api/logs',   (req,res) => res.json(logs.slice(0,100)));

/* ═══════════════════════════════════════════
   DÉMARRAGE
═══════════════════════════════════════════ */
/* ═══ Prévenir les crashes sur erreurs non catchées ═══ */
process.on('uncaughtException', e => {
  log('⚠️ Erreur non catchée: '+e.message, 'ERROR');
  if(status==='running') status='waiting_cookies';
});
process.on('unhandledRejection', e => {
  log('⚠️ Promise rejetée: '+(e&&e.message||e), 'ERROR');
  if(status==='running') status='waiting_cookies';
});

app.listen(CFG.PORT, () => {
  log(`Dashboard port ${CFG.PORT}`);
  if(!accounts.yapson.username||!accounts.mgmt.username){
    log('⚠️ Comptes non configurés — configure-les depuis le dashboard','WARN');
    status='error';
  } else {
    startBot().catch(e=>{log('Erreur fatale: '+e.message,'ERROR');status='error';});
  }
});
