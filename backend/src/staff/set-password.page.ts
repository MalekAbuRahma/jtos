import { Controller, Get, Header } from '@nestjs/common';

/**
 * T-005: the page an invitation link opens. Until the admin web exists, the API serves it itself.
 * The token is read from the URL fragment (#token=…) or typed in, so it never reaches server logs.
 */
@Controller()
export class SetPasswordPageController {
  @Get('set-password')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'")
  page(): string {
    return PAGE;
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JTOS · Set your password</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F6F1E9;color:#1C2422;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:400px;margin:16px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 1px 3px rgba(28,36,34,.1)}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 20px;color:#5B6765;font-size:14px;line-height:20px}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;height:46px;border:1px solid #D9D2C6;border-radius:10px;padding:0 12px;font-size:16px}
button{width:100%;height:50px;margin-top:20px;border:0;border-radius:12px;background:#1F5F5B;color:#fff;font-size:17px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}.msg{margin-top:14px;font-size:14px;line-height:20px}.err{color:#B42318}.ok{color:#1E6440}
.tag{display:inline-block;font-size:12px;background:#FCEFD9;color:#8A5A12;border-radius:999px;padding:2px 10px;margin-bottom:12px}
</style></head><body><main>
<span class="tag">Staging · test data only</span>
<h1>Set your password</h1>
<p>Use at least 12 characters. After this, sign in with your email, your password and a code we email you.</p>
<form id="f" novalidate>
<label for="t">Invitation code</label><input id="t" autocomplete="off" spellcheck="false" required>
<label for="p">New password</label><input id="p" type="password" autocomplete="new-password" minlength="12" required>
<label for="c">Type it again</label><input id="c" type="password" autocomplete="new-password" required>
<button id="b" type="submit">Set password</button><div id="m" class="msg" role="status"></div>
</form></main>
<script>
var h=new URLSearchParams(location.hash.slice(1)).get('token')||new URLSearchParams(location.search).get('token');if(h){document.getElementById('t').value=h;history.replaceState(null,'',location.pathname);}
document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();
var t=document.getElementById('t').value.trim(),p=document.getElementById('p').value,c=document.getElementById('c').value,m=document.getElementById('m'),b=document.getElementById('b');
m.className='msg err';if(!t){m.textContent='Paste your invitation code.';return}if(p.length<12){m.textContent='Use at least 12 characters.';return}if(p!==c){m.textContent='The two passwords are different.';return}
b.disabled=true;m.className='msg';m.textContent='Saving…';
try{var r=await fetch('/v1/staff/auth/set-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,password:p})});
if(r.ok){m.className='msg ok';m.textContent='Done. Your password is set — you can close this page.';document.getElementById('f').reset();}
else{var j={};try{j=await r.json()}catch(_){}m.className='msg err';m.textContent=j.message||'Something went wrong. Try again.';b.disabled=false;}}
catch(_){m.className='msg err';m.textContent='No connection. Try again.';b.disabled=false;}});
</script></body></html>`;
