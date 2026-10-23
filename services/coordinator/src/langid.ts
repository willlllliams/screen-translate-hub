// Paragraph language identification (spec 04 section 3.4). v1 uses scripts plus
// small character and stop-word lists; it can be replaced by a library (lingua)
// behind the same function. Returns undefined when unsure.
import { scriptHistogram, type Script } from '@sth/model';

// Characters that exist only in one of the two Chinese scripts (common ones).
const SIMPLIFIED_ONLY = new Set([...
  '们这个来时国说会为对发开关后现经进学还实问门见点动间长业车东么从书头义乐两亲认语话请读谁调队边过运达远选还钱铁银长门闭阳际陆随隐难电页顶项预领题风飞饭馆马驾验鱼鸟鸡黄齐龙让设评识译试诗询该详误说谈谢证资质贵买卖费赛赶趋车转轻较辆输办务动劳势单卫历厂县发叶号听启员响团围图国圆圣场块坏坚垒报币帅师带帮库应废开张归录忆志态总恋悬惊惯戏战执扩扫扬护报担拥择挤损换据摄摆携击权杂条极构标样桥梦检楼欢气汉汤沟没泪泼洁浅测济浓涨涛润渊渐湾湿满滚滞灭灯灵灾炉点烂热爱爷牵状独狮猎环现电画畅疗疮监盖盘码础确硕礼祸离种积称稳穷窃竞笔筑签简类粮紧纠红纤约级纪纯纲纳纵纸纹线练组细织终绍经结绕给络绝统继绩绪续维绵综绿缓编缘缩网罗罚罢职联聪肃肠肤肾肿胀胁胆胜胶脏脑脸腊舰艺节芦苏苹茎荐荡荣药莱获营萧蓝虑虽蚁蛮补衬袜见观规视览觉触计订认讨让训议讯记讲许论设访证评识诉诊词译试话诚询该详语误说请诸诺读谁课调谅谈谋谓谜谢谨谱贝负贡财责贤败货质贩贪贫购贯贵贷贸费贺贼资赋赌赏赔赖赚赞赠赢赵赶跃践踪车轨轩转轮软轰轻载较辅辆辈辉输辑边辽达迁过迈运还这进远违连迟适选递逻遗邓邮邻郑酱释钟钢钥钩钱钳铁铃铅铜铭银锁锅锋错锡锦键锻镇镜长门闪闭问闯闲间闷闸闹闻阀阁阅队阳阴阵阶际陆陈陕险随隐难雾静韦韩页顶项顺须顽顾顿预领频题颜额风飘飞饥饭饮饰饱饼馆馒马驰驱驳驴驶驻驾驿骂骄骆骏验骑骗骚鱼鲁鲜鸟鸡鸣鸭鸽鹅鹰麦黄齐齿龄龙龟'.slice(0)]);
const TRADITIONAL_ONLY = new Set([...
  '們這個來時國說會為對發開關後現經進學還實問門見點動間長業車東麼從書頭義樂兩親認語話請讀誰調隊邊過運達遠選錢鐵銀閉陽際陸隨隱難電頁頂項預領題風飛飯館馬駕驗魚鳥雞黃齊龍讓設評識譯試詩詢該詳誤談謝證資質貴買賣費賽趕趨輕較輛輸辦務勞勢單衛歷廠縣葉號聽啟員響團圍圖圓聖場塊壞堅壘報幣帥師帶幫庫應廢張歸錄憶誌態總戀懸驚慣戲戰執擴掃揚護擔擁擇擠損換據攝擺攜擊權雜條極構標樣橋夢檢樓歡氣漢湯溝沒淚潑潔淺測濟濃漲濤潤淵漸遊灣濕滿滾滯滅燈靈災爐爛熱愛爺牽狀獨獅獵環畫暢療瘡監蓋盤碼礎確碩禮禍離種積稱穩窮竊競筆築簽簡類糧緊糾紅纖約級紀純綱納縱紙紋線練組細織終紹結繞給絡絕統繼績緒續維綿綜綠緩編緣縮網羅罰罷職聯聰肅腸膚腎腫脹脅膽勝膠臟腦臉臘艦藝節蘆蘇蘋範莖薦蕩榮藥萊獲營蕭藍慮雖蟻蠻補襯襪觀規視覽覺觸計訂討訓議訊記講許論訪訴診詞誠諸諾課諒謀謂謎謹譜貝負貢財責賢敗貨販貪貧購貫貸貿賀賊賦賭賞賠賴賺讚贈贏趙躍踐蹤軌軒輪軟轟載輔輩輝輯遼遷邁違遲適遞邏遺鄧郵鄰鄭醬釋鐘鋼鑰鉤鉗鈴鉛銅銘鎖鍋鋒錯錫錦鍵鍛鎮鏡閃闖閒悶閘鬧聞閥閣閱陰陣階陳陝險霧靜韋韓順須頑顧頓頻顏額飄饑飲飾飽餅饅馳驅駁驢駛駐驛罵驕駱駿騎騙騷魯鮮鳴鴨鴿鵝鷹麥齒齡龜'.slice(0)]);

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'you', 'with', 'on', 'this', 'are', 'be', 'or', 'not', 'your', 'we', 'have', 'from', 'can', 'will', 'more', 'an', 'by', 'at', 'as', 'our', 'all'],
  fr: ['le', 'la', 'les', 'des', 'est', 'et', 'une', 'un', 'du', 'que', 'qui', 'dans', 'pour', 'pas', 'sur', 'vous', 'nous', 'avec', 'au', 'sont', 'ce', 'il', 'elle', 'plus'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'sich', 'auf', 'für', 'sie', 'es', 'im', 'dem', 'von', 'wir', 'ich', 'auch', 'oder', 'werden'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'no', 'se', 'del', 'al', 'lo', 'como', 'más', 'pero', 'su', 'está'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'di', 'che', 'e', 'un', 'una', 'per', 'non', 'sono', 'con', 'del', 'della', 'nel', 'è', 'si', 'come', 'anche', 'questo'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'um', 'uma', 'para', 'com', 'não', 'do', 'da', 'em', 'no', 'na', 'por', 'mais', 'se', 'você', 'são', 'está'],
  nl: ['de', 'het', 'een', 'en', 'van', 'ik', 'te', 'dat', 'die', 'in', 'is', 'niet', 'op', 'met', 'voor', 'zijn', 'je', 'ook', 'aan', 'wordt'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'dari', 'ada', 'akan', 'kami', 'anda', 'pada', 'juga', 'atau'],
  tr: ['ve', 'bir', 'bu', 'da', 'de', 'için', 'ile', 'çok', 'ne', 'daha', 'gibi', 'olarak', 'değil', 'ama', 'sonra'],
  pl: ['i', 'w', 'nie', 'na', 'się', 'jest', 'to', 'że', 'do', 'z', 'jak', 'co', 'ale', 'od', 'po', 'tak', 'dla'],
};
const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)])) as Record<string, Set<string>>;
const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

function zhVariant(text: string): string {
  let s = 0;
  let t = 0;
  for (const ch of text) {
    if (SIMPLIFIED_ONLY.has(ch)) s++;
    else if (TRADITIONAL_ONLY.has(ch)) t++;
  }
  if (s > t) return 'zh-Hans';
  if (t > s) return 'zh-Hant';
  return 'zh';
}

function latinGuess(text: string): string | undefined {
  if (VIETNAMESE.test(text)) return 'vi';
  const words = text.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  if (words.length === 0) return undefined;
  let best: string | undefined;
  let bestHits = 0;
  for (const [lang, set] of Object.entries(STOP_SETS)) {
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    if (hits > bestHits) [best, bestHits] = [lang, hits];
  }
  if (bestHits >= 2 || (bestHits >= 1 && words.length <= 6)) return best;
  return undefined;
}

export function dominantScript(text: string): Script | undefined {
  const h = scriptHistogram(text);
  let best: Script | undefined;
  let n = 0;
  for (const [s, c] of h) if (c > n) [best, n] = [s, c];
  return best;
}

export function detectLanguage(text: string): string | undefined {
  const h = scriptHistogram(text);
  const total = [...h.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  const kana = h.get('kana') ?? 0;
  const han = h.get('han') ?? 0;
  const hangul = h.get('hangul') ?? 0;
  if (kana > 0 && kana + han >= 0.5 * total) return 'ja';
  if (hangul >= 0.5 * total) return 'ko';
  if (han >= 0.5 * total) return zhVariant(text);
  const top = dominantScript(text);
  switch (top) {
    case 'arabic':
      return 'ar';
    case 'hebrew':
      return 'he';
    case 'cyrillic':
      return 'ru';
    case 'thai':
      return 'th';
    case 'latin':
      return latinGuess(text);
    default:
      return undefined;
  }
}
