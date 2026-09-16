// ⚠️ **`test/` に置かないこと。** Node 20 の `node --test test/` は、そこにある `.js` を
//    すべて実行する。置いてあったため、検査を回すたびに比べる土台を作り直していた
//    （Valhalla を焼き直したあとなら、比較の土台が消えるところだった）
const fs=require("fs");
const {routeWithValhalla, speedSpans, BASE}=require("/Users/teradatakumi/Documents/touring_spot_share_web/admin/lib/valhallaRoute");
const 区間=[
 ["北海道 札幌→富良野",[141.3544,43.0618],[142.3833,43.3422]],
 ["東北 仙台→山形",[140.8694,38.2682],[140.3396,38.2554]],
 ["東北 盛岡→八幡平",[141.1527,39.7036],[140.8560,39.9580]],
 ["関東 前橋→草津",[139.0608,36.3895],[138.5960,36.6210]],
 ["関東 秩父→奥多摩",[139.0786,35.9911],[139.0960,35.8090]],
 ["中部 松本→高山",[137.9720,36.2380],[137.2520,36.1461]],
 ["中部 静岡→御殿場",[138.3830,34.9756],[138.9346,35.3086]],
 ["北陸 金沢→白川郷",[136.6256,36.5613],[136.9060,36.2600]],
 ["近畿 京都→天橋立",[135.7681,35.0116],[135.1830,35.5680]],
 ["近畿 奈良→高野山",[135.8048,34.6851],[135.5850,34.2130]],
 ["中国 岡山→蒜山",[133.9195,34.6551],[133.6390,35.2900]],
 ["中国 広島→三次",[132.4596,34.3853],[132.8520,34.8060]],
 ["四国 高松→剣山",[134.0434,34.3401],[134.0940,33.8540]],
 ["四国 松山→四万十",[132.7657,33.8416],[132.9330,33.2000]],
 ["九州 熊本→阿蘇",[130.7417,32.8032],[131.0850,32.8840]],
 ["九州 鹿児島→霧島",[130.5581,31.5966],[130.8690,31.8900]],
 // ⚠️ **この件の発端。** 秩父往還の way/138336643・46145093・731030715 が
 //    maxspeed 未登録で90km/h扱いになり、雷電廿六木橋経由が「8分遅い」と判定される
 ["国道140号 道の駅大滝温泉→広瀬ダム",[138.93776,35.94965],[138.76376,35.83867]],
];
(async()=>{
 const out=[];
 for(const [name,from,to] of 区間){
  const r=await routeWithValhalla(from,to,{displacement:"large",baseUrl:BASE});
  if(r.error){ console.log(`  ⚠️ ${name} 失敗 ${r.error}`); continue; }
  const km=r.lengthMeters/1000;
  if(km>=200){ console.log(`  ⚠️ ${name} ${km.toFixed(0)}km は200km制限を超える。除外`); continue; }
  const spans=await speedSpans(r.points,"motorcycle",BASE);
  if(!spans){ console.log(`  ⚠️ ${name} traceできない`); continue; }
  out.push({name, from, to, lengthMeters:r.lengthMeters, points:r.points});
  console.log(`  ${name.padEnd(18)} ${km.toFixed(0).padStart(4)}km 辺${String(spans.length).padStart(4)}`);
 }
 fs.writeFileSync("/Users/teradatakumi/Documents/touring_spot_share_web/admin/test/fixtures-speed-sections.json",
   JSON.stringify({
     "⚠️ なぜ線を焼き込むか":"焼き直しの前後で同じ線を測るため。線を固定しないと「経路が変わった」と「速度が変わった」が混ざる",
     "⚠️ 作り直し方":"admin で node makeSpeedFixtures.js（Valhalla を焼き直したあとに作り直してはいけない。比較の土台が消える）",
     作成日:new Date().toISOString().slice(0,10),
     costing:"motorcycle（displacement: large）",
     sections:out}, null, 1));
 console.log(`\n${out.length}区間を書き出しました`);
})();
