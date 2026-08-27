# dsh-overleaf

[English](README.md) | [涓枃](README.zh.md)

DeepSeek Harness锛圖SH锛塛eb 鐨?**Overleaf 宓屽叆宸ヤ綔鍙?*鎻掍欢銆傚畠鍦ㄤ細璇濋〉椤堕儴鐨?`瀵硅瘽 / 杞ㄨ抗 / 涓婁笅鏂嘸 鏃佹柊澧炵鍥涗釜閫夐」锛氶€氳繃鍚屾簮鍙嶅悜浠ｇ悊鍔犺浇浣犵殑 Overleaf 绔欑偣锛堝叕鏈変簯鎴栬嚜鎵樼锛屽 `https://tex.nju.edu.cn`锛夛紝椤甸潰**瀹屾暣鍙搷浣?*鈥斺€旂紪杈戙€佺紪璇戙€丳DF 棰勮鍏ㄩ儴淇濈暀鈥斺€旈〉闈笅鏂逛粛鏄師鐢?DSH 瀵硅瘽杈撳叆妗嗭紱閫夊尯寮曠敤銆佸厜鏍囧鍐欏叆銆丩aTeX 杈呭姪闈㈡澘鍦ㄤ袱鑰呬箣闂存墦閫氥€?
```
+--------------------------------------------------------------+
|  浼氳瘽椤甸€夐」鏉?  瀵硅瘽 | 杞ㄨ抗 | 涓婁笅鏂?| [Overleaf]              |
+--------------------------------------------------------------+
|  宸ュ叿鏍? 鍒锋柊 / 鏂扮獥鍙?/ 鐧诲綍 / Cookie / 杈呭姪闈㈡澘              |
|  +----------------------------------------------------------+ |
|  |  https://.../overleaf-proxy/...锛堝悓婧?iframe锛?           | |
|  |  Overleaf 缂栬緫鍣ㄣ€佺紪璇戝櫒銆丳DF 棰勮鍏ㄩ儴鍙敤                 | |
|  +----------------------------------------------------------+ |
|  閫夊尯娴姩銆屽紩鐢ㄣ€嶆皵娉?鈥斺€?閫夊尯妗?                               |
|  鐘舵€佹潯 / 杈呭姪闈㈡澘锛堝厜鏍囨彃鍏ャ€佹枃妗ｅぇ绾测€︹€︼級                     |
+--------------------------------------------------------------+
|  DSH composer锛堝師鐢燂紝鏈仛浠讳綍鏀瑰姩锛?                           |
+--------------------------------------------------------------+
```

- 璁稿彲璇侊細MIT
- 鐩爣杩愯鏃讹細DeepSeek Harness `0.1.1-rc.2` web profile锛坄http://127.0.0.1:3080`锛?- 鍗忚锛氶檮甯︾鍚?[dsh-std](https://github.com/Yan-Zero/dsh-std) 浜掓搷浣滆鑼冪殑闈欐€?Community v0.15 `dsh-plugin.json` 娓呭崟锛涚粡鍏稿弻鍗婂尯 bundle 鍔犺浇浠嶆槸涓绘縺娲昏矾寰勩€?
## 涓轰粈涔堥渶瑕佸畠

Overleaf 鐨勬瘡涓搷搴旈兘甯?`X-Frame-Options` / CSP `frame-ancestors`锛岀洿鎺?`<iframe src="https://tex.nju.edu.cn">` 浼氳娴忚鍣ㄦ嫆缁濄€傛湰鎻掍欢鍦?DSH 瀹夸富杩涚▼鍐呭疄鐜颁簡涓€涓?HTTP/1.1 鍙嶅悜浠ｇ悊锛氭祻瑙堝櫒鎵€鏈夎姹傝蛋 `/overleaf-proxy/<鍘熻矾寰?` 鍐嶈浆鍙戝埌浣犻厤缃殑涓婃父绔欑偣鈥斺€斾笂娓歌閿佸畾涓哄敮涓€閰嶇疆鏉ユ簮锛屾病鏈夊紑鏀?SSRF 闈€俰frame 涓?GUI 鍚屾簮涔嬪悗锛屾祻瑙堝櫒绾фˉ鎺ユ墠鎴愪负鍙兘锛氬祵鍏ョ紪杈戝櫒閲岀殑鏂囨湰閫夊尯鍙互缁撴瀯鍖栧湴杩涘叆瀵硅瘽妗嗭紝鐢熸垚鐨勫唴瀹逛篃鍙互鍐欏洖缂栬緫鍣ㄥ厜鏍囧銆?
## 鍔熻兘涓庨獙鏀跺鐓?
| 闇€姹?| 瀹炵幇鐘舵€?|
|---|---|
| R1 路 浼氳瘽椤电 4 涓€夐」 | `conversation.view` 鏉＄洰 `id:"overleaf"`銆乣order:30`锛涘畼鏂?tab 鏉″彲瑙佹椂鍗冲彲瑙侊紙tabs >= 2锛?|
| R2 路 鍙厤缃湴鍧€ | 璁剧疆椤碉紙璁剧疆 > 鎻掍欢 > 鎻掍欢閰嶇疆 > dsh-overleaf锛変慨鏀?`baseUrl`锛涗繚瀛樺悗鐑垏鎹唬鐞嗙洰鏍囷紝鏃犻渶閲嶅惎 |
| R3 路 鍘熺珯鍔熻兘鍙敤 | 娴佸紡鍙嶅悜浠ｇ悊淇濈暀璺緞涓庢煡璇覆锛涘搷搴旈櫎鍙栨櫙闄愬埗澶村閫忎紶锛涘皬骞?HTML 姝ｆ枃鍋氶摼鎺?璧勬簮閲嶅畾鍩哄苟娉ㄥ叆妗ユ帴鑴氭湰 |
| R4 路 搴曢儴鍘熺敓杈撳叆妗?| 瑙嗗浘鍙浛鎹㈡秷鎭尯鍩燂紱composer銆佸伐浣滃尯璁板綍銆佷氦浠樼墿涓€姒備笉鍔?|
| R5 路 閫夊尯寮曠敤 | iframe 鍐?`selectionchange` 娴嚭寮曠敤鎸夐挳锛涚偣鍑荤粡瀹樻柟寮曠敤绠＄嚎鍐欏叆 chip锛坄inputTriggers.registerSource({name:'quote-ref'})` codec锛夛紝绠＄嚎缂哄け鏃堕€€鍖栦负绾枃鏈潡寮曠敤 |
| R6 路 鍏夋爣澶勭敓鎴?| 妯℃澘鎻掑叆锛坰ection/subsection/figure/table/equation/BibTeX锛変笌鑷敱绮樿创閫氳繃 CodeMirror API 鍐欏叆瀹炴椂鍏夋爣锛圕M5 涓婚€氶亾锛孋M6 鎺㈡祴锛屽彲缂栬緫鍏滃簳锛夈€傝嚜鍔ㄥ啓鍏ユā鍨嬪洖澶嶅垪鍏ュ悗缁鍒掞紱鎸変换鍔′功瑕佹眰娉ㄦ槑鎵€灞?lane |
| R7 路 杈呭姪鍔熻兘 | 杈呭姪闈㈡澘锛氫粠缂栬緫鍣ㄧ紦鍐叉娊鍙栨枃妗ｅぇ绾插苟鍙烦杞棯鐑侊紱鐧诲綍/鐧诲嚭/Cookie 绠＄悊锛涚姸鎬佷笂鎶ワ紙`assistPanelEnabled` 寮€鍏虫帶鍒堕潰鏉挎樉闅愶級 |

## 瀹夎

npm 鍖呭悕宸茶鍙︿竴椤圭洰鍗犵敤锛屽洜姝や粎閫氳繃 GitHub 鎴?tarball 鍒嗗彂锛?
```sh
# 浠?GitHub releases 瀹夎锛堟帹鑽愶級锛?dsh plugin --profile web add github:gychen-NJU/dsh-overleaf

# 浠?release 璧勪骇瀹夎锛?dsh plugin --profile web add ./dsh-overleaf-0.1.1.tgz
```

闅忓悗閲嶅惎涓€娆?web 鏈嶅姟锛堝鎴风 bundle 鍦ㄥ惎鍔ㄦ湡杩涘叆 boot 鍥捐氨锛夛細

```sh
dsh --profile web web        # 鐢ㄤ綘骞虫椂鐨勬柟寮忓惎鍔ㄥ嵆鍙?```

纭缁勫悎浠嶇劧鎴愮珛锛?
```sh
dsh --profile web --dump-config   # 搴旂湅鍒?"# == dsh-overleaf" 閰嶇疆鍧?```

闅忔椂鍙互骞插噣鍗歌浇锛?
```sh
dsh plugin --profile web remove dsh-overleaf
```

### 鍏卞瓨淇濊瘉

鍒绘剰閬垮紑宸茬煡鎻掍欢鐨勬瘡涓€鏉″懡鍚嶉潰锛?
| 闈?| dsh-overleaf 鍗犵敤 | 鍏朵粬鎻掍欢宸叉湁鍗犵敤 |
|---|---|---|
| Cordis 琛?id | `overleaf-workbench` | `overleaf`锛坆etter-overleaf锛?|
| 瀹㈡埛绔ā鍧?id | `dsh-overleaf`锛堝繀椤荤瓑浜庡寘鍚嶏級 | `dsh-better-overleaf` |
| HTTP 璺敱 | `/overleaf-proxy/*`銆乣/overleaf/workbench/*` | `/overleaf/*`锛坆etter-overleaf锛夈€乣/api/dsh-browser/*` |
| WS 鍗囩骇 | `/overleaf-proxy/socket.io[/]` 绮剧‘鍖归厤 | 鏃犲凡鐭?|
| 鍑嵁 ref | `OVERLEAF_WORKBENCH_COOKIE` | `OVERLEAF_COOKIE` / `OVERLEAF_GIT_TOKEN` |
| 鏁版嵁鐩綍 | `~/.dsh/plugin-data/dsh-overleaf-workbench/browser-profile` | `~/.dsh/plugin-data/dsh-overleaf/...` |
| 浼氳瘽瑙嗗浘 id | `overleaf`锛宱rder 30 | chat 0 / trajectory 10 / context 20 |

涓や晶鍏ㄩ儴杞け璐ワ細缂?`credentials` 鏈嶅姟鍒欏仠鐢ㄥ嚟鎹瓨鍌紙姣忔璇锋眰閫€鍖栦负鎵嬪姩绮樿创妯″紡锛夈€佺己 `settings` 鍒欒烦杩囪缃崱锛涘鎴风浠讳綍寮傚父鍙墦鏃ュ織涓嶆姏鍑猴紝缁濅笉闃诲 GUI 鍚姩銆?
## 鏋舵瀯

```
src/
  index.ts          瀹夸富渚х粺涓€瀵煎嚭 + 榛樿 Service 绫伙紙cordis loader 鐩爣锛?  service.ts        璺敱銆乻tatus/login/projects 鎿嶄綔銆乻ettings 鍛藉悕绌洪棿鎺ョ嚎
  config.ts         schemastery schema + 榛樿鍊?+ origin 褰掍竴鍖?  proxy.ts          ReverseProxy锛氭祦寮?HTTP 鍙嶄唬 + 鍘熷鍗囩骇闅ч亾
  inject-script.ts  娴忚鍣ㄦˉ鎺ヨ剼鏈?bridge.js 鐨勬簮澶?  login-cdp.ts      鐩磋繛 CDP 鐧诲綍锛堢Щ妞嶈嚜 Hoemr/dsh-better-overleaf, MIT锛?  credentials.ts    OVERLEAF_WORKBENCH_COOKIE credentialRef
  types.ts          wire 绫诲瀷
  client/
    index.ts        瀹㈡埛绔?apply(): 瀛楀吀銆乹uote-ref source銆佽鍥炬Ы浣嶃€?                    璁剧疆鍗℃Ы浣嶏紙瀵?settingsScope 杞瓑寰咃級
    view.tsx        OverleafView 缁勪欢锛堝伐鍏锋爮/iframe/CTA/闈㈡澘/瀵硅瘽妗嗭級
    workbench.ts    鏍?ctx 鎹曡幏銆佸紩鐢ㄦ敞鍐岃〃銆乧omposer 鍐欏叆杈呭姪
    settings-card.tsx  鎸?'dsh-overleaf' 鍛藉悕绌洪棿鐨勬殏瀛樺紡璁剧疆琛ㄥ崟
    locales.ts      zh/en 骞抽摵瀛楀吀锛坺h 涓?key 婧愶級
scripts/
  smoke-offline.mjs 鍋囦笂涓嬫枃澶瑰叿锛氳矾鐢辨櫘鏌ャ€丣SON 娴佺▼銆丠TML 閲嶅啓鏂█銆?                    cookie/logout 鐢熷懡鍛ㄦ湡銆乧lient factory 鐗╁寲 + stub 鏈嶅姟涓婄殑
                    apply()
  smoke-live.mjs    浠ョ湡瀹?@deepseek-ai/dsh-host-webserver 璧?OS 闅忔満绔彛锛?                    鎸囧悜鏈湴 fixture 涓婃父锛岄獙璇侀噸瀹氬熀/娉ㄥ叆銆丼et-Cookie 鏀跺煙銆?                    浜岃繘鍒舵祦銆丣SON 璺敱銆佺湡瀹?RFC6455 闅ч亾寰€杩斻€乥ridge.js 璧勪骇璺敱
```

璇锋眰閾捐矾姒傝堪锛?
1. 娴忚鍣ㄥ悜 DSH 鏈嶅姟鍣ㄨ姹?`/overleaf-proxy/<path>?<query>`銆?2. 瀹夸富 handler 閲嶅缓澶撮儴锛坔ost 鏀瑰啓涓轰笂娓搞€佸鎵?`Origin`銆乧ookie 涓庡凡瀛樺嚟鎹悎骞躲€佹枃鏈鏂囦繚鎸?identity 缂栫爜浠ヤ究鏀瑰啓锛夈€?3. 涓婃父鍝嶅簲娴佸紡杞彂锛涘搷搴斿ご璋冩暣锛氬幓 `X-Frame-Options`銆佷粠 CSP 绉婚櫎 `frame-ancestors`銆佺粷瀵归噸瀹氬悜鏀规寕鍒颁唬鐞嗗墠缂€涓嬨€乣Set-Cookie` 鐨?Domain 灞炴€у墺绂伙紙Cookie 钀戒负 host-only锛夈€?4. 涓嶈秴杩?4MB 鐨?`text/html` 缂撳啿涓€娆″鐞嗭細鏍圭浉瀵圭殑 `href/src/action/poster/data-src` 涓?`srcset` 鍔犲墠缂€锛屽苟鍦?`<head>` 鍚庢敞鍏?`<base href="/overleaf-proxy/">` 涓庢ˉ鎺ヨ剼鏈€傝秴澶?HTML 鍙婂叾浠栫被鍨嬩竴寰嬪師鏍锋祦寮忋€?5. WebSocket锛氱湡瀹?webserver 鎶婄簿纭崌绾ц矾寰勫垎娲剧粰 TCP/TLS 闅ч亾鈥斺€斿悜涓婃父閲嶆斁鎻℃墜瀛楄妭鍐嶅弻鍚戦€愬瓧鑺傛嫾鎺ャ€?
鍦ㄨ浠ｇ悊鏂囨。鍐咃紝妗ユ帴鑴氭湰瀹夎闃插尽鎬у寘瑁咃紙`fetch`銆乣XMLHttpRequest.open`銆乣EventSource`銆乣WebSocket`锛夛紝璁╄繍琛屾湡鏂板缓鐨勬牴鐩稿 URL 涔熻惤鍥炲墠缂€锛涘悜鐖剁獥鍙ｄ笂鎶ラ€夊尯鍙樺寲锛涙毚闇插厜鏍囧啓鍏?澶х翰/璺宠浆鍛戒护锛涘苟鍦ㄦ瘡娆″彉鏇村墠淇濆瓨 localStorage 蹇収渚涘洖婊氥€?
## 鐧诲綍

涓ゆ潯璺緞鍏辩敤鍚屼竴鍑嵁搴擄細

- **鐩磋繛 CDP 鎶撳彇锛堟帹鑽愶級**锛氭彃浠剁敤浣犻€夋嫨鐨?Chromium 绯绘祻瑙堝櫒锛坄auto` 鑷姩鍙戠幇榛樿娴忚鍣ㄤ笌宸茶 Chromium锛涘彲鎸囧畾娓犻亾鎴栬矾寰勶級浠ョ嫭绔嬮厤缃洰褰曪紙`~/.dsh/plugin-data/dsh-overleaf-workbench/browser-profile`锛夊姞棰勭暀 loopback 璋冭瘯绔彛鍚姩銆傜櫥褰曚竴娆″悗杞 `Storage.getCookies` / `Network.getAllCookies`锛岀洿鍒板嚭鐜伴厤缃富鏈虹殑 `overleaf_session*` Cookie 涓旀湁椤甸潰鎶佃揪 `<baseUrl>/project*`銆侰ookie 琛屽啓鍏?`ctx.credentials`锛坄OVERLEAF_WORKBENCH_COOKIE`锛夛紝姝ゅ悗闅忔瘡涓唬鐞嗚姹備笂琛屻€?- **鎵嬪姩绮樿创**锛欴evTools 澶嶅埗鏁磋 Cookie 缁忓伐鍏锋爮瀵硅瘽妗嗙矘璐村叆搴擄紱淇濆瓨鍓嶄互 redirect-manual GET 鏍￠獙 `<baseUrl>/project`銆?
Cookie 鍊间粠涓嶈繘鍏ユ彃浠?config銆佽矾鐢辫繑鍥炲€笺€佹棩蹇楁垨瀹㈡埛绔瓨鍌ㄣ€?
## 瀹夊叏妯″瀷

- 鎵€鏈夋彃浠惰矾鐢?socket 绾?loopback 鍥存爮锛坄127.0.0.1`/`::1`锛夛紱闈炲洖鐜皟鐢ㄨ€呭湪璇诲彇璇锋眰浣撲箣鍓嶅氨琚?403銆?- 浠ｇ悊鐩爣閿佸畾鍗曚竴閰嶇疆 origin鈥斺€擴RL 瑙ｆ瀽鎷掔粷鍗忚/璺緞/涓绘満瑕嗙洊锛屼笉瀛樺湪寮€鏀句腑缁с€?- 鍙栨櫙淇濇姢鍙杩欎竴涓敤鎴蜂富鍔ㄩ€夋嫨鐨勪笂娓告斁瀹斤紝涓斿彧鏈嶅姟浜庡埢鎰忚姹傚畠鐨?loopback 瀹㈡埛绔紱鍏朵綑澶村叏閮ㄤ繚鐣欍€?- 璇峰儚瀵瑰緟浠讳綍鑳芥寔鏈変綘 LaTeX 璐﹀彿浼氳瘽鐨勫伐鍏蜂竴鏍峰寰?`baseUrl`锛氬彧鏈夊綋浣犵殑宸ヤ綔绔欐湰韬氨鏄俊浠昏竟鐣屾椂鎵嶆帴鍏ュ唴缃戝疄渚嬨€?- Cookie 鍙笂琛岃浆鍙戙€佷粠涓嶅嚭鐜板湪 API 杩斿洖閲岋紱logout 绔嬪嵆娓呴櫎瀛樺偍鐨勫嚟鎹€?- 宓屽叆椤典笌 GUI 鍚屾簮锛屼笂娓歌剼鏈篃鍦ㄥ叾涓繍琛屸€斺€旇鑷瀹℃煡鎵€宓屽叆鐨勫唴瀹广€?
## 宸茬煡闄愬埗

- Cookie 甯︿笂娓告爣蹇椾綅锛氱幇浠?Chrome/Firefox/Edge 璁や负 loopback 鍙俊锛宍Secure` Cookie 鍙粡 `http://127.0.0.1:3080` 涓嬪彂锛涜€佹祻瑙堝櫒鍙兘涓㈠純锛堝涓讳晶娉ㄥ叆涓嶅彈褰卞搷锛夈€?- WS 绮剧‘鍖归厤瑕佹眰瀹㈡埛绔闂?`/overleaf-proxy/socket.io[/]`锛氭ˉ鎺ュ寘瑁呬細鏀瑰啓鏍囧噯璺緞锛涚粫杩囪繖浜涜矾寰勭殑鐗规畩浼犺緭灏嗛€€鍖栧埌杞銆?- 鏌愪簺绾鎴风妗嗘灦璁＄畻鐨?URL 渚濊禆鍖呰涓?`<base>` 鍏滃簳锛涜嫢绔欑偣寮€鍚棤鍏宠矾寰勭殑澶栬繛閫氶亾闇€鑷琛ヨ矾鐢辫鍒欍€?- CM6 鏀寔渚濊禆甯歌鍙ユ焺鎺㈡祴锛涜嫢 Overleaf 瀹屾垚 CM6 杩佺Щ涓斿唴閮ㄥ彞鏌勪笉鍚岋紝妯℃澘鎻掑叆閫€鍖栦负鍙紪杈戠劍鐐瑰厹搴曘€?- 鍏湁浜戜釜鍒」鐩〉鍙兘鍑虹幇绌虹櫧鎴栭噸澶嶆覆鏌擄紝闇€瑕佹寜瀹炰緥鐗堟湰寰皟閲嶅畾鍩鸿鍒欙紱鍦ㄥ涓讳晶璁?`DSH_OVERLEAF_DEBUG=1` 鍙墦鍗?CSP 鍓ョ鏃ュ織銆?
## 寮€鍙?
```sh
pnpm install
pnpm build        # tsc -b锛堢被鍨?+ 鍙繍琛?ESM/CJS 鍙戝皠鐗╋級鍐?tsdown
pnpm test         # smoke-offline.mjs + smoke-live.mjs锛堟棤闇€璧?DSH 瀹炰緥锛?pnpm typecheck
```

鏋勫缓浜х墿涓?`lib/index.js`锛坣ode 鍗婂尯锛孍SM锛変笌 `lib/client.js`锛堟祻瑙堝櫒鍗婂尯锛屾儼鎬?CJS 闂寘锛岀粡 `window.__ModuleLoader__.load({ id:'dsh-overleaf', factory })` 娉ㄥ唽鈥斺€旀ā鍧?id 蹇呴』绛変簬 npm 鍖呭悕锛宍dsh-client-modules` 灏辨槸鎸夊寘鍚嶅尮閰嶆瘡涓?`/plugins/<pkg>/client.js` bundle 鐨勬敞鍐岋級銆傚鎴风 bundle 鍙厑璁?require 骞冲彴绉嶅瓙琛ㄤ腑鐨?React锛堝惈 jsx-runtime锛夛紝鍏朵綑鍏ㄩ儴鍐呰仈鈥斺€旂函搴﹂棬涓庣ぞ鍖烘儻渚嬩竴鑷淬€?
瑕佸湪鐪熷疄 profile 閲岃瘯鐢ㄦ湰鍦版敼鍔細鎵撳寘 tarball 鍚?add銆侀噸鍚?web 鏈嶅姟锛岀劧鍚庡悓鏃惰瀵熷澹充笌 iframe 涓や唤 DevTools 鎺у埗鍙颁腑 `[dsh-overleaf]` 鍓嶇紑鏃ュ織銆?
## 鍏煎鎬ц鏄?
- 閽堝 DSH `0.1.1-rc.2` web profile 楠岃瘉锛沺eer 鍖洪棿鎺ュ彈瀹夸富鏈嶅姟 `>=0.1.0-rc.5`銆乧ordis `^4.0.1`銆?- Node `^22.19 || >=24`銆?- 鍙笌 `dsh-better-sidebar` / `dsh-better-overleaf` / `dsh-context` / paperlab 绛夊苟瀛橈紱瑙佸叡瀛樿〃銆?- `dsh-plugin.json` 閬靛惊 dsh-std Community v0.15锛涘疄鐜颁簡 `@dsh-std/adapter-dsh` 鐨?Host 鍙潤鎬佸彂鐜拌娓呭崟锛屾櫘閫?profile 鐩存帴蹇界暐銆?
## 鑷磋阿

- [Hoemr/dsh-better-overleaf](https://github.com/Hoemr/dsh-better-overleaf)锛圡IT锛夛細鐩磋繛 CDP 鐧诲綍璁捐锛屽凡鍦?`login-cdp.ts` 涓€傞厤锛堝煙鍚嶅弬鏁板寲杩囨护 + 涓撳睘閰嶇疆鐩綍锛夈€?- [Nono-neko/dsh-browser](https://github.com/Nono-neko/dsh-browser)锛氶獙璇佷簡 DSH 涓婂悓婧愬弽鍚戜唬鐞?+ loopback 鍥存爮妯″紡銆?- [wangwei-wade/dsh-quote-annotate](https://github.com/wangwei-wade/dsh-quote-annotate)锛氬缓绔嬩簡寮曠敤 chip 鐨勬彃鍏?搴忓垪鍖栨祦绋嬶紝鏈彃浠跺皢鍏舵墿灞曞埌浠ｇ悊椤甸潰銆?- [Yan-Zero/dsh-std](https://github.com/Yan-Zero/dsh-std)锛氭湰鍖呴伒寰殑闈欐€佹竻鍗曞崗璁€?
## 璁稿彲璇?
[MIT](LICENSE)
