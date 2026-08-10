// ==UserScript==
// @name          Disney+ Interactive Subtitles
// @version       2.9
// @match         *://*.disneyplus.com/*
// @match         *://disneyplus.com/*
// @run-at        document-idle
// @connect       api.openai.com
// @grant         GM_xmlhttpRequest
// @grant         unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================
  // CONFIGURATION - Its fine to hardcode the API key here since it's tied to a specific project with usage limits. Just be mindful of sharing this script publicly.
  // =========================================================
  const OPENAI_API_KEY = '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';

  // =========================================================
  // SETTINGS — הגדרות גודל תצוגה (נשמרות ב-localStorage)
  // =========================================================
  const SCRIPT_VERSION = '2.9';   // מוצג בכותרת פאנל ההגדרות — לזיהוי מהיר שהגרסה שרצה מעודכנת
  console.log('%c[TM Disney Subtitles] v' + SCRIPT_VERSION + ' loaded', 'color:#0063e5;font-weight:bold');
  const SETTINGS_DEFAULTS = {
    overlayFontSize: 3,           // vw — גודל כתוביות (בתוך clamp)
    overlayBottom: 20,            // % — גובה הכתוביות מתחתית המסך
    wordPopupScale: 1.0,          // מכפיל גודל חלונית מילה (zoom)
    sentencePopupWidth: 980,      // px — רוחב חלונית תרגום
    sentencePopupFontScale: 1.0,  // מכפיל גודל טקסט בחלונית תרגום
    aiModel: 'terra',              // מודל AI לתרגום (ראה MODEL_OPTIONS)
    showContext: '',                // הקשר הסדרה — תיאור חופשי (שם הסדרה, דמויות, ז'אנר)
    audioBoost: 1                   // מכפיל עוצמת שמע (1 = ללא הגברה, ראה סעיף AUDIO BOOST)
  };

  // GPT-5.6 (Sol/Terra/Luna), כל אחד ב-reasoning_effort שנבחר לאיזון שונה של מהירות/אינטליגנציה/מחיר.
  // price = $ ל-1M טוקן פלט. מקור: Artificial Analysis, אוגוסט 2026.
  const MODEL_OPTIONS = [
    { key: 'luna-fast',  model: 'gpt-5.6-luna',  effort: 'none',   label: 'Luna — מהיר', price: 0.24 },
    { key: 'luna-smart', model: 'gpt-5.6-luna',  effort: 'medium', label: 'Luna — חכם',  price: 0.24 },
    { key: 'terra',      model: 'gpt-5.6-terra', effort: 'medium', label: 'Terra',        price: 9.6 },
    { key: 'sol',        model: 'gpt-5.6-sol',   effort: 'low',    label: 'Sol',          price: 30 }
  ];

  function getModelOption() {
    return MODEL_OPTIONS.find(o => o.key === settings.aiModel) || MODEL_OPTIONS[2];
  }

  const SETTINGS_KEY = 'tm-disney-subtitle-settings';

  let settings = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      return saved ? { ...SETTINGS_DEFAULTS, ...saved } : { ...SETTINGS_DEFAULTS };
    } catch { return { ...SETTINGS_DEFAULTS }; }
  })();
  if (!MODEL_OPTIONS.some(o => o.key === settings.aiModel)) settings.aiModel = SETTINGS_DEFAULTS.aiModel;

  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

  // דיסני+ מגיש את הנגן בכמה תבניות נתיב (/play/<id>, /video/<id>, ובגרסאות חדשות גם אחרות),
  // ולכן זיהוי לפי ה-URL בלבד לא אמין. הגיבוי: וידאו טעון שאורכו כשל פרק או סרט —
  // כך הטריילר הקצר שרץ ברקע בדף הבית לא נחשב בטעות לנגן.
  function isOnPlayerPage() {
    if (/\/(play|video)\//.test(location.pathname)) return true;
    const v = getPlayerVideo();
    return !!v && v.readyState >= 1 && v.duration > 300;
  }

  // שכבת הכתוביות של דיסני+ (dss-subtitle-renderer) — מסודר מהספציפי לכללי, נבחרת ההתאמה הראשונה.
  // הסלקטורים הרחבים בסוף הם רשת ביטחון אם דיסני משנה שמות מחלקות; סינון תפריטים נעשה ב-scrapeSubtitleText.
  const SUBTITLE_SELECTOR = '[class*="subtitle-renderer" i], [class*="dss-subtitle" i], [class*="timedtext" i], [class*="caption-window" i], [class*="closed-caption" i], [class*="caption" i], [class*="subtitle" i]';

  // אלמנטים שהם חלק מתפריט/כפתור ולא מהכתוביות עצמן
  const INTERACTIVE_ANCESTORS = 'button, a, input, select, [role="button"], [role="radio"], [role="menu"], [role="menuitem"], [role="listbox"], [role="dialog"], [role="tablist"]';

  // סרגל הבקרה של הנגן — שם יושב שעון הזמן שנותר, שנתפס בטעות ע"י הסלקטור הרחב של "caption"
  // (מערכות עיצוב נוהגות לקרוא לסגנון טקסט קטן "caption"). אין כאן "time" סתם — זה היה פוסל גם timedtext.
  const CONTROLS_ANCESTORS = '[class*="control" i], [class*="progress" i], [class*="slider" i], [class*="scrubber" i], [class*="timeline" i], [class*="seek" i], [class*="duration" i], [data-testid*="control" i], [data-testid*="scrubber" i]';

  // טקסט שהוא רק ספרות/נקודתיים/מקפים — שעון, לא כתובית
  const TIMECODE_RE = /^[\s\d:.\-–—/]+$/;

  function overlayFontExpr() {
    const s = settings.overlayFontSize;
    const min = Math.round(34 * (s / 3));
    const max = Math.round(60 * (s / 3));
    return `clamp(${min}px, ${s}vw, ${max}px)`;
  }

  // =========================================================
  // AUDIO BOOST — הגברת עוצמת השמע מעבר ל-100%
  // video.volume חסום ב-1.0, ולכן הקול מנותב דרך Web Audio:
  //   source → analyser (גלאי שקט) → gain (ההגברה) → limiter (מונע עיוות) → רמקולים.
  // כרום מתיר ניתוב אודיו של תוכן מוגן-DRM (רק captureStream נחסם), אבל אם בכל זאת
  // יוצא שקט — הגלאי מכבה את ההגברה ומבקש רענון, כי חיבור source הוא חד-כיווני
  // ואי אפשר לנתק אותו מהאלמנט בלי לטעון את הדף מחדש.
  // =========================================================
  const AUDIO_MAX_BOOST = 5;
  let audioCtx = null, audioNodes = null, audioBoostBlocked = false;
  const audioSourced = new WeakMap();   // <video> שכבר עבר createMediaElementSource — אסור לנסות פעמיים
  const audioProbe = new Float32Array(512);

  function audioBoostValue() {
    const v = parseFloat(settings.audioBoost);
    return isNaN(v) ? 1 : Math.min(AUDIO_MAX_BOOST, Math.max(1, v));
  }

  // האלמנט שבאמת מנגן. נשארים נעולים עליו עד שהוא יורד מה-DOM, כדי לא לבנות גרף כפול
  function mainVideoEl() {
    if (audioNodes && audioNodes.video.isConnected) return audioNodes.video;
    const vids = Array.from(document.querySelectorAll('video'))
      .sort((a, b) => b.clientWidth - a.clientWidth);
    return vids.filter(v => !v.paused)[0] || vids[0] || null;
  }

  function attachAudioBoost(video) {
    if (audioSourced.has(video)) return false;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { audioBoostBlocked = true; return false; }
      audioCtx = new AC();
    }
    // הקשר מושהה מנתב את הקול לשומקום — מתחברים רק כשהוא באמת רץ
    if (audioCtx.state !== 'running') { audioCtx.resume().catch(() => {}); return false; }
    audioSourced.set(video, true);
    try {
      const source = audioCtx.createMediaElementSource(video);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      const gain = audioCtx.createGain();
      const limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = 0.003; limiter.release.value = 0.25;
      // שמירה על ריבוי ערוצים (5.1) במקום דחיסה לסטריאו
      try { audioCtx.destination.channelCount = audioCtx.destination.maxChannelCount; } catch {}
      source.connect(analyser); analyser.connect(gain); gain.connect(limiter);
      limiter.connect(audioCtx.destination);
      audioNodes = { video, gain, analyser, silentTicks: 0, verified: false };
      return true;
    } catch (e) {
      // InvalidStateError = האלמנט כבר נתפס ע"י AudioContext אחר (תוסף הגברה למשל)
      audioBoostBlocked = true;
      console.warn('[TM Disney Subtitles] audio boost unavailable:', e && e.message);
      return false;
    }
  }

  function applyAudioBoost() {
    const boost = audioBoostValue();
    if (audioNodes) {
      audioNodes.gain.gain.setTargetAtTime(boost, audioCtx.currentTime, 0.02);
      return;
    }
    if (boost <= 1 || audioBoostBlocked) return;   // ב-100% לא נוגעים בקול בכלל
    const video = mainVideoEl();
    if (video && attachAudioBoost(video)) applyAudioBoost();
  }

  function verifyAudioBoost() {
    const n = audioNodes;
    const v = n && n.video;
    if (!n || n.verified) return;
    if (v.paused || v.muted || !v.volume || v.readyState < 3) return;
    n.analyser.getFloatTimeDomainData(audioProbe);
    let peak = 0;
    for (let i = 0; i < audioProbe.length; i++) { const a = Math.abs(audioProbe[i]); if (a > peak) peak = a; }
    if (peak > 0.0005) { n.verified = true; return; }
    if (++n.silentTicks < 10) return;   // ~10 שניות של שקט מוחלט תוך כדי נגינה = הדפדפן חסם
    audioBoostBlocked = true;
    settings.audioBoost = 1;
    saveSettings();
    n.gain.gain.value = 1;
    updateAudioBoostUI();
  }

  function syncAudioBoost() {
    if (audioNodes) {
      if (!audioNodes.video.isConnected) { audioNodes = null; return; }
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
      verifyAudioBoost();
      return;
    }
    // רק בנגן — כדי לא לתפוס את אלמנט הטריילר שרץ ברקע בדף הבית
    if (!isOnPlayerPage()) return;
    if (audioBoostBlocked || audioBoostValue() <= 1) return;
    applyAudioBoost();
  }

  function updateAudioBoostUI() {
    const panel = document.getElementById('tm-settings-panel');
    if (!panel) return;
    const inp = panel.querySelector('input[data-key="audioBoost"]');
    if (inp) { inp.value = settings.audioBoost; inp.disabled = audioBoostBlocked; }
    const val = panel.querySelector('.tm-setting-val[data-key="audioBoost"]');
    if (val) val.textContent = audioBoostValue() + '×';
    const note = panel.querySelector('#tm-audio-note');
    if (note) note.style.display = audioBoostBlocked ? 'block' : 'none';
  }

  // רשימה סטטית רחבה - תיקון שמות מקומי ללא עלות
  const PROPER_NOUNS_LIST = [
    // --- Suits Universe (Extended) ---
    "Harvey", "Specter", "Mike", "Ross", "Donna", "Paulsen", "Louis", "Litt", "Rachel", "Zane",
    "Jessica", "Pearson", "Robert", "Hardman", "Daniel", "Sheila", "Sazs", "Katrina", "Bennett",
    "Gretchen", "Samantha", "Wheeler", "Alex", "Williams", "Travis", "Tanner", "Sean", "Cahill",
    "Harvard", "Manhattan", "Pearson", "Hardman", "Darby", "Specter", "Litt", "Zane", "Wheeler",
    "Williams", "Forstman", "Charles", "Anita", "Gibbs", "Cameron", "Dennis", "Trevor", "Evans",
    "Jenny", "Griffith", "Esther", "Edith", "Gordon", "Marcus", "Harold", "Gunderson", "Oliver", "Grady",

    // --- Legal Terms & Professional Titles ---
    "Attorney", "Lawyer", "Partner", "Associate", "Subpoena", "Litigation", "Affidavit", "Deposition",
    "Counselor", "Your Honor", "Court", "Judge", "Officer", "Agent", "Detective", "Captain", "Sheriff",
    "Professor", "Doctor", "President", "Senator", "Governor", "Mayor", "Minister", "Chancellor",
    "Director", "Executive", "Manager", "Chairman", "General", "Colonel", "Major", "Sergeant", "Lieutenant",
    "Justice", "Magistrate", "Prosecutor", "Defendant", "Plaintiff", "Bailiff", "Notary", "Solicitor",

    // --- Popular First Names (Male) ---
    "Liam", "Noah", "Oliver", "Elijah", "James", "William", "Benjamin", "Lucas", "Henry", "Theodore",
    "Jack", "Levi", "Alexander", "Jackson", "Mateo", "Daniel", "Michael", "Mason", "Sebastian", "Ethan",
    "Logan", "Owen", "Samuel", "Arlo", "Jacob", "Asher", "Aiden", "John", "Joseph", "Wyatt", "David",
    "Leo", "Luke", "Julian", "Hudson", "Grayson", "Matthew", "Ezra", "Gabriel", "Carter", "Isaac",
    "Jayden", "Luca", "Anthony", "Dylan", "Lincoln", "Thomas", "Maverick", "Christopher", "Jaxon",
    "Josiah", "Charles", "Caleb", "Christopher", "Miles", "Josiah", "Isaiah", "Andrew", "Joshua",
    "Nathan", "Nolan", "Adrian", "Cameron", "Santiago", "Eli", "Aaron", "Ryan", "Angel", "Cooper",
    "Waylon", "Easton", "Kai", "Christian", "Landon", "Colton", "Roman", "Axel", "Brooks", "Jonathan",
    "Robert", "Jameson", "Ian", "Everett", "Greyson", "Wesley", "Jeremiah", "Hunter", "Leonardo",
    "Jordan", "Jose", "Bennett", "Silas", "Nicholas", "Parker", "Beau", "Weston", "Austin", "Connor",
    "Carson", "Dominic", "Xavier", "Jaxson", "Jace", "Adam", "Eric", "Peter", "Steven", "Steve",
    "Harry", "Joe", "Rick", "Morty", "Walter", "Jesse", "Saul", "Dexter", "Sherlock", "Matt", "Kevin",
    "George", "Patrick", "Victor", "Derek", "Brian", "Brandon", "Kenneth", "Gregory", "Russell", "Philip",
    "Vincent", "Craig", "Keith", "Gerald", "Frank", "Raymond", "Eugene", "Darren", "Bruce", "Stanley",
    "Bernard", "Clifford", "Warren", "Roy", "Terrence", "Troy", "Vernon", "Marco", "Diego", "Rafael",
    "Carlos", "Pablo", "Andre", "Marcel", "Henrik", "Klaus", "Cedric", "Desmond", "Reginald", "Rodney",
    "Dustin", "Kurt", "Tyrone", "Preston", "Clayton", "Quincy", "Donovan", "Edgar", "Frederick", "Gilbert",
    "Hector", "Herman", "Hugh", "Jasper", "Lawrence", "Malcolm", "Max", "Neil", "Norman", "Oscar",
    "Otis", "Perry", "Quentin", "Ralph", "Rex", "Roderick", "Roger", "Roland", "Ruben", "Rupert",
    "Salvatore", "Shane", "Spencer", "Sterling", "Tobias", "Tyler", "Ulysses", "Vaughn", "Wayne", "Wendell",
    "Zachary", "Zander", "Alberto", "Alfonso", "Alvin", "Archie", "Arnold", "Barry", "Blake", "Brad",
    "Brent", "Bryce", "Byron", "Cody", "Corey", "Curtis", "Damon", "Dante", "Darius", "Daryl",
    "Dwight", "Edmund", "Edwin", "Felix", "Fernando", "Franklin", "Garrett", "Glenn", "Gus", "Hank",
    "Heath", "Homer", "Ivan", "Jake", "Jay", "Jeff", "Jerome", "Jimmy", "Johnny", "Karl",
    "Lance", "Larry", "Leon", "Lionel", "Lloyd", "Marvin", "Maurice", "Monty", "Myles", "Ned",
    "Nigel", "Noel", "Omar", "Otto", "Paul", "Percy", "Phil", "Pierce", "Randall", "Reggie",
    "Reid", "Rhett", "Rocco", "Rudy", "Rufus", "Sam", "Seth", "Sheldon", "Simon", "Solomon",
    "Stefan", "Stuart", "Ted", "Terry", "Tim", "Todd", "Tommy", "Tony", "Trent", "Vince",
    "Virgil", "Wallace", "Willis", "Winston", "Yuri", "Zeke", "Nick", "Clint", "Brock", "Chad",

    // --- Popular First Names (Female) ---
    "Olivia", "Emma", "Charlotte", "Amelia", "Sophia", "Mia", "Isabella", "Ava", "Evelyn", "Luna",
    "Harper", "Sofia", "Scarlett", "Elizabeth", "Eleanor", "Emily", "Chloe", "Mila", "Violet", "Penelope",
    "Gianna", "Aria", "Abigail", "Ella", "Avery", "Hazel", "Nora", "Layla", "Lily", "Aurora",
    "Nova", "Ellie", "Madison", "Grace", "Isla", "Willow", "Zoe", "Riley", "Stella", "Eliana",
    "Ivy", "Victoria", "Maya", "Natalie", "Naomi", "Elena", "Sarah", "Ariana", "Allison", "Gabriella",
    "Alice", "Madelyn", "Cora", "Ruby", "Eva", "Serenity", "Autumn", "Adeline", "Hailey", "Gianna",
    "Valentina", "Isla", "Lulu", "Amaya", "Quinn", "Nevaeh", "Jade", "Piper", "Brielle", "Mary",
    "Alexandra", "Kelsey", "Jane", "Jennifer", "Jessica", "Michelle", "Amy", "Anna", "Rachel",
    "Monica", "Phoebe", "Kate", "Catherine", "Rose", "Robin", "Kim", "Nancy", "Claire", "Victoria",
    "Rebecca", "Brittany", "Tiffany", "Heather", "Amber", "Megan", "Lauren", "Andrea", "Courtney", "Danielle",
    "Diana", "Dorothy", "Frances", "Gloria", "Helen", "Irene", "Jacqueline", "Jasmine", "Jocelyn", "Karen",
    "Laura", "Linda", "Lisa", "Lorraine", "Lydia", "Margaret", "Melissa", "Maria", "Carmen", "Lucia",
    "Bianca", "Paige", "Paula", "Sandra", "Stephanie", "Susan", "Teresa", "Vanessa", "Wendy", "Alicia",
    "Angela", "Annette", "Barbara", "Bethany", "Beverly", "Bonnie", "Brenda", "Bridget", "Candace", "Carla",
    "Carol", "Carolyn", "Cassandra", "Cecilia", "Celeste", "Christine", "Cindy", "Colleen", "Constance", "Darlene",
    "Deborah", "Denise", "Dolores", "Edna", "Eileen", "Elaine", "Erica", "Felicia", "Fiona", "Florence",
    "Gail", "Geraldine", "Gina", "Gladys", "Harriet", "Holly", "Ingrid", "Iris", "Jolene", "Joyce",
    "Judith", "Julia", "June", "Kathleen", "Kay", "Kendra", "Kristen", "Kristina", "Leah", "Lena",
    "Lillian", "Lois", "Lori", "Louise", "Lucille", "Lucy", "Marcella", "Marcia", "Marilyn", "Marion",
    "Marlene", "Martha", "Maureen", "Maxine", "Miranda", "Miriam", "Molly", "Nadine", "Norma", "Pamela",
    "Patricia", "Peggy", "Phyllis", "Priscilla", "Regina", "Renee", "Rita", "Roberta", "Rosa", "Rosalie",
    "Roxanne", "Ruth", "Sabrina", "Sally", "Selena", "Sharon", "Shirley", "Sonia", "Stacy", "Sylvia",
    "Tamara", "Tammy", "Tanya", "Tara", "Theresa", "Tina", "Tracy", "Ursula", "Valerie", "Vera",
    "Veronica", "Virginia", "Vivian", "Wanda", "Whitney", "Yvonne", "Natasha", "Anastasia", "Francesca",
    "Gwendolyn", "Genevieve", "Clarissa", "Daphne", "Dominique", "Monique", "Yvette", "Marie", "Simone",

    // --- Surnames ---
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
    "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
    "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
    "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
    "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts",
    "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker", "Cruz", "Edwards", "Collins", "Reyes",
    "Stewart", "Morris", "Morales", "Murphy", "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper",
    "Peterson", "Bailey", "Reed", "Kelly", "Howard", "Ramos", "Kim", "Cox", "Ward", "Richardson",
    "Watson", "Brooks", "Chavez", "Wood", "James", "Bennett", "Gray", "Mendoza", "Ruiz", "Hughes","Leeds",
    "Sullivan", "Kennedy", "Marshall", "Hart", "Foster", "Stone", "Burns", "Fox", "Santos", "Greene",
    "Douglas", "Ferguson", "Palmer", "Burton", "Hamilton", "Crawford", "Cunningham", "Fletcher", "Gibson", "Gordon",
    "Harrison", "Hawkins", "Henderson", "Hunt", "Jennings", "Johnston", "Lambert", "Lane", "Lawrence", "Long",
    "Lynch", "Murray", "Nash", "Owen", "Perry", "Pope", "Price", "Grant", "Reynolds", "Ross",
    "Sanders", "Sharp", "Shaw", "Shelton", "Sherman", "Simmons", "Spencer", "Stephens", "Warner", "Waters",
    "Webb", "Wolfe", "Barker", "Bates", "Bishop", "Blair", "Bolton", "Booth", "Bowen", "Bradley",
    "Brewer", "Briggs", "Burke", "Caldwell", "Cannon", "Carlson", "Carpenter", "Carr", "Carroll", "Chambers",
    "Chapman", "Chase", "Cooke", "Cortez", "Cross", "Daniels", "Decker", "Delaney", "Duncan", "Dunn",
    "Duran", "Erickson", "Espinoza", "Estrada", "Farrell", "Figueroa", "Fisher", "Fitzgerald", "Fleming", "Franco",
    "Frazier", "Freeman", "French", "Frost", "Fuller", "Gallagher", "Gardner", "Gentry", "Gill", "Goodman",
    "Graham", "Griffin", "Gross", "Guerrero", "Hale", "Hammond", "Hampton", "Hanna", "Hardy", "Harmon",
    "Hayden", "Hayes", "Haynes", "Hensley", "Hicks", "Higgins", "Hobbs", "Hoffman", "Hogan", "Holland",
    "Holmes", "Holt", "Hood", "Horton", "Howell", "Hubbard", "Humphrey", "Hutchinson", "Ingram", "Irwin",
    "Jacobs", "Jefferson", "Jensen", "Kemp", "Kent", "Kerr", "Kirk", "Klein", "Knox", "Kramer",
    "Landry", "Larson", "Lowe", "Lyons", "Malone", "Manning", "Marks", "Marsh", "Mccoy", "Mcdonald",
    "Mcgee", "Mckenzie", "Mclean", "Meadows", "Mercer", "Meyer", "Monroe", "Montgomery", "Moody", "Moss",
    "Mueller", "Mullins", "Myers", "Neal", "Newton", "Noble", "Norris", "Obrien", "Osborne", "Padilla",
    "Patel", "Payne", "Pearce", "Pena", "Perkins", "Peters", "Pittman", "Poole", "Powers", "Proctor",
    "Ramsey", "Randolph", "Rich", "Robbins", "Robertson", "Rojas", "Rollins", "Romero", "Rowe", "Salazar",
    "Saunders", "Schneider", "Schwartz", "Soto", "Stafford", "Stanton", "Stark", "Steele", "Stevens", "Stokes",
    "Sutton", "Swanson", "Thornton", "Townsend", "Tucker", "Valentine", "Vance", "Vargas", "Walters", "Webster",
    "Welch", "Whitaker", "Wilkins", "Williamson", "Winters", "Wise", "Woodward", "Yates", "York", "Zimmerman",
    "Barrett", "Floyd", "Page", "Savage", "Drake", "Blackwell", "Burnett", "Donaldson", "Ellison", "Glover",

    // --- Countries & Nations ---
    "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Argentina", "Armenia", "Australia",
    "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium",
    "Belize", "Benin", "Bhutan", "Bolivia", "Botswana", "Brazil", "Bulgaria", "Cambodia", "Cameroon",
    "Canada", "Chile", "China", "Colombia", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czechia",
    "Denmark", "Dominica", "Ecuador", "Egypt", "Estonia", "Ethiopia", "Fiji", "Finland", "France",
    "Georgia", "Germany", "Ghana", "Greece", "Guatemala", "Honduras", "Hungary", "Iceland", "India",
    "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan",
    "Kenya", "Korea", "Kuwait", "Latvia", "Lebanon", "Liberia", "Libya", "Lithuania", "Luxembourg",
    "Malaysia", "Maldives", "Malta", "Mexico", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco",
    "Netherlands", "New Zealand", "Nigeria", "Norway", "Oman", "Pakistan", "Panama", "Paraguay", "Peru",
    "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Saudi Arabia", "Serbia", "Singapore",
    "Slovakia", "Slovenia", "South Africa", "Spain", "Sri Lanka", "Sweden", "Switzerland", "Syria", "Taiwan",
    "Thailand", "Turkey", "Ukraine", "United Arab Emirates", "United Kingdom", "USA", "Uruguay", "Uzbekistan",
    "Vatican", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe", "America", "England", "Europe", "Asia",

    // --- Major Cities (Global & US) ---
    "London", "Paris", "New York", "Tokyo", "Berlin", "Madrid", "Rome", "Moscow", "Beijing", "Seoul",
    "Bangkok", "Singapore", "Dubai", "Sydney", "Toronto", "Chicago", "Los Angeles", "San Francisco",
    "Miami", "Boston", "Washington", "Seattle", "Austin", "Dallas", "Houston", "Denver", "Phoenix",
    "Philadelphia", "Atlanta", "Portland", "Las Vegas", "Hollywood", "Manhattan", "Brooklyn", "Queens",
    "Amsterdam", "Vienna", "Prague", "Warsaw", "Budapest", "Stockholm", "Oslo", "Copenhagen", "Helsinki",
    "Tel Aviv", "Jerusalem", "Haifa", "Cairo", "Istanbul", "Mumbai", "Delhi", "Shanghai", "Hong Kong",
    "Mexico City", "Sao Paulo", "Buenos Aires", "Lima", "Santiago", "Bogota", "Rio de Janeiro",
    "Barcelona", "Munich", "Milan", "Lisbon", "Dublin", "Brussels", "Zurich", "Geneva", "Athens",

    // --- US States ---
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
    "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
    "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
    "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
    "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
    "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
    "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",

    // --- Brands & Tech Corporations ---
    "Google", "Apple", "Microsoft", "Amazon", "Facebook", "Meta", "Instagram", "Twitter", "X Corp",
    "LinkedIn", "Netflix", "Disney", "Sony", "Samsung", "Tesla", "SpaceX", "Toyota", "Ford", "BMW",
    "Mercedes", "Audi", "Nike", "Adidas", "Puma", "Coca-Cola", "Pepsi", "McDonald's", "Starbucks",
    "Visa", "Mastercard", "American Express", "Intel", "Nvidia", "Adobe", "Salesforce", "Oracle",
    "IBM", "Uber", "Airbnb", "Spotify", "Snapchat", "TikTok", "YouTube", "WhatsApp", "Zoom",
    "Dell", "HP", "Lenovo", "Asus", "Nintendo", "Xbox", "PlayStation", "Lego", "Mattel", "IKEA",
    "Walmart", "Target", "Costco", "Ferrari", "Lamborghini", "Porsche", "Rolex", "Gucci", "Prada",
    "Chanel", "Louis Vuitton", "Hermes", "Zara", "H&M", "Gap", "Levi's", "Nestle", "Kellogg's",

    // --- Science & Nature (Planets, Elements, Concepts) ---
    "Earth", "Mars", "Jupiter", "Saturn", "Venus", "Mercury", "Uranus", "Neptune", "Pluto", "Sun", "Moon",
    "Milky Way", "Andromeda", "Alpha Centauri", "Hydrogen", "Helium", "Oxygen", "Carbon", "Nitrogen",
    "Gold", "Silver", "Iron", "Einstein", "Newton", "Darwin", "Tesla", "Hawking", "Curie", "Galileo",
    "Copernicus", "Hubble", "NASA", "CERN", "Interstellar", "Cosmos", "Quantum", "Evolution",

    // --- Pop Culture (Characters, Movies, Series) ---
    "Batman", "Superman", "Spider-Man", "Iron Man", "Thor", "Hulk", "Captain America", "Black Widow",
    "Wolverine", "Joker", "Harry Potter", "Hermoine", "Ron Weasley", "Dumbledore", "Voldemort",
    "James Bond", "Indiana Jones", "Luke Skywalker", "Darth Vader", "Yoda", "Frodo", "Gandalf", "Sauron",
    "Mickey Mouse", "Donald Duck", "Simba", "Sherlock Holmes", "Watson", "Hercules", "Zeus", "Thor",
    "Game of Thrones", "Breaking Bad", "Stranger Things", "The Office", "Friends", "Seinfeld",
    "Marvel", "DC", "Star Wars", "Star Trek", "Lord of the Rings", "Hogwarts", "Gotham", "Metropolis",

    // --- Religions, Languages & Spiritual Terms ---
    "God", "Lord", "Jesus", "Christ", "Muhammad", "Allah", "Buddha", "Brahma", "Vishnu", "Shiva",
    "Christianity", "Islam", "Judaism", "Hinduism", "Buddhism", "Sikhism", "Bible", "Quran", "Torah",
    "Vatican", "Mecca", "Jerusalem", "English", "Spanish", "French", "German", "Chinese", "Japanese",
    "Hebrew", "Arabic", "Russian", "Portuguese", "Italian", "Hindi", "Latin", "Greek",

    // --- Calendar, Months & Days ---
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
    "Christmas", "Easter", "Halloween", "Thanksgiving", "Hanukkah", "Ramadan", "Passover", "New Year",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "Spring", "Summer", "Autumn", "Winter",

    // --- Web, Tech & Programming ---
    "Python", "JavaScript", "Java", "HTML", "CSS", "React", "Angular", "Vue", "Node", "Docker",
    "Kubernetes", "Linux", "Windows", "MacOS", "iOS", "Android", "GitHub", "Stack Overflow",
    "Bitcoin", "Ethereum", "Blockchain", "AI", "Machine Learning", "Cloud", "Server", "Database",

    // --- Geography & Landmarks ---
    "Everest", "Kilimanjaro", "Alps", "Himalayas", "Andes", "Rockies", "Sahara", "Amazon", "Nile",
    "Mississippi", "Danube", "Pacific", "Atlantic", "Indian", "Arctic", "Antarctic", "Grand Canyon",
    "Eiffel Tower", "Statue of Liberty", "Big Ben", "Great Wall", "Colosseum", "Taj Mahal", "Pyramids",

    // --- Miscellaneous Common Capitalized ---
    "World", "International", "National", "History", "Modern", "West", "East", "North", "South",
    "Olympics", "World Cup", "Nobel", "Oscar", "Grammy", "Emmy", "BAFTA", "Golden Globe",
    "University", "College", "Academy", "Institute", "Union", "Federation", "Alliance", "Organization",

      // --- Calendar: Months, Abbreviations & Hebrew Months ---
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
    "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    "Tishrei", "Cheshvan", "Kislev", "Tevet", "Shevat", "Adar", "Nisan", "Iyar", "Sivan", "Tammuz", "Av", "Elul",

    // --- Days & Specific Times ---
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
    "Spring", "Summer", "Autumn", "Fall", "Winter", // לעיתים נכתבים באות קטנה, אך בשמות אירועים או עונות רשמיות באות גדולה
    "Mid-Autumn", "Solstice", "Equinox",

    // --- Eras & Historical Periods ---
    "BC", "AD", "BCE", "CE", "Renaissance", "Medieval", "Victorian", "Edwardian", "Jurassic", "Cretaceous",
    "Bronze Age", "Iron Age", "Stone Age", "Information Age", "Digital Age",

    // --- Generated Expansion (auto-generated) ---
    "Abel", "Adan", "Adrien", "Aidan", "Alaric", "Aldo", "Alessio", "Alfred", "Alistair", "Alonso",
    "Alvaro", "Ambrose", "Amos", "Andreas", "Angus", "Ansel", "Antoine", "Anton", "Antonio", "Archer",
    "Ari", "Armand", "Armando", "Arthur", "Ashton", "Atlas", "Atticus", "Augustus", "Aurelius", "Axl",
    "Bartholomew", "Basil", "Beckett", "Benedict", "Benicio", "Benson", "Bentley", "Bjorn", "Blaine", "Blaise",
    "Bo", "Bobby", "Boris", "Brady", "Braxton", "Brendan", "Brennan", "Brett", "Broderick", "Bronson",
    "Bruno", "Bryant", "Bryn", "Buck", "Burt", "Callum", "Calvin", "Camden", "Carl", "Carlton",
    "Carmelo", "Casey", "Casper", "Caspian", "Cecil", "Cesar", "Chandler", "Charlie", "Chester", "Chip",
    "Clarence", "Claude", "Clement", "Clyde", "Colt", "Cornelius", "Cristian", "Crosby", "Cullen", "Cyrus",
    "Dalton", "Damian", "Dane", "Darian", "Darnell", "Dawson", "Dax", "Declan", "Delbert", "Demetrius",
    "Denis", "Denny", "Dermot", "Devin", "Dewey", "Dillon", "Dimitri", "Dirk", "Dominik", "Dorian",
    "Doug", "Draven", "Duane", "Dusty", "Eamon", "Eddie", "Edmond", "Eduardo", "Efrain", "Egan",
    "Eldon", "Elias", "Elliot", "Ellis", "Elmer", "Emerson", "Emil", "Emilio", "Emmanuel", "Emmett",
    "Enoch", "Enrique", "Enzo", "Ephraim", "Erasmus", "Esteban", "Evan", "Ezekiel", "Fabian", "Farley",
    "Felipe", "Fergus", "Finley", "Finn", "Flynn", "Forest", "Forrest", "Francis", "Fraser", "Freddie",
    "Fritz", "Gabe", "Gage", "Galen", "Gareth", "Garland", "Garrison", "Gary", "Gavin", "Gene",
    "Geoffrey", "Gerard", "Gideon", "Giles", "Giovanni", "Glen", "Gonzalo", "Grover", "Guillermo", "Gunnar",
    "Gunther", "Gustavo", "Guy", "Hal", "Hamish", "Hans", "Harlan", "Harley", "Hasan", "Hendrix",
    "Herbert", "Holden", "Horace", "Hubert", "Hugo", "Iago", "Ibrahim", "Idris", "Ignacio", "Igor",
    "Imran", "Ira", "Irving", "Ishmael", "Ismael", "Ivor", "Jacoby", "Jaime", "Jakob", "Jamari",
    "Jamal", "Jared", "Jarvis", "Javier", "Jaylen", "Jean", "Jeb", "Jedidiah", "Jermaine", "Jerald",
    "Jessie", "Jethro", "Joaquin", "Jody", "Joel", "Johan", "Jonas", "Jonah", "Jorge", "Josue",
    "Juan", "Judah", "Jude", "Julius", "Junior", "Justin", "Kade", "Kaden", "Kaleb", "Kameron",
    "Kane", "Kareem", "Keanu", "Keegan", "Kellen", "Kelvin", "Kendall", "Kendrick", "Kenny", "Kenzo",
    "Kermit", "Khalil", "Kian", "Kieran", "Kingsley", "Kip", "Kit", "Kobe", "Kolby", "Korey",
    "Kristopher", "Kyle", "Kyler", "Lamar", "Lamont", "Langston", "Lars", "Laurence", "Leandro", "Lennon",
    "Lennox", "Leonard", "Leroy", "Lester", "Linus", "Llewellyn", "Lochlan", "Loren", "Lorenzo", "Louie",
    "Lucian", "Luis", "Luther", "Lyle", "Lysander", "Mack", "Maddox", "Magnus", "Malachi", "Malik",
    "Manuel", "Marc", "Marcelo", "Marcos", "Mario", "Marius", "Marlon", "Mathias", "Matteo", "Matthias",
    "Maximilian", "Maximus", "Maxwell", "Melvin", "Memphis", "Merlin", "Micah", "Miguel", "Milo", "Milton",
    "Mohamed", "Montague", "Morton", "Moses", "Mustafa", "Nathanael", "Nathaniel", "Nehemiah", "Neville", "Nico",
    "Niall", "Nikolas", "Norbert", "Oakley", "Odin", "Orion", "Orlando", "Orson", "Oswald", "Paco",
    "Paolo", "Pascal", "Pedro", "Penn", "Percival", "Peyton", "Piers", "Porter", "Prince", "Quinton",
    "Rajan", "Ramiro", "Ramon", "Raphael", "Rashid", "Raul", "Reese", "Remy", "Rene", "Reuben",
    "Reynaldo", "Rhys", "Ricardo", "Richard", "Rigby", "River", "Roberto", "Rocky", "Rodrigo", "Rogan",
    "Rolando", "Ronan", "Rory", "Roscoe", "Rowan", "Rudolph", "Ruslan", "Rusty", "Ryder", "Ryker",
    "Sage", "Salvador", "Samir", "Samson", "Sandro", "Sawyer", "Seamus", "Sergio", "Shawn", "Shelby",
    "Sidney", "Silvio", "Sonny", "Stephan", "Stephen", "Stetson", "Sven", "Tad", "Tate", "Terrance",
    "Thaddeus", "Theo", "Theron", "Titus", "Toby", "Tom", "Tomas", "Trace", "Trenton", "Tristan",
    "Ty", "Tyson", "Ulrich", "Uriel", "Valentino", "Van", "Vidal", "Vinnie", "Waldo", "Walt",
    "Werner", "Wes", "Wilbur", "Wiley", "Will", "Willem", "Wolfgang", "Woodrow", "Xander", "Yakov",
    "Yosef", "Yusuf", "Zach", "Zacharias", "Zavier", "Zion", "Ada", "Adalyn", "Adele", "Adelaide",
    "Adriana", "Adrienne", "Agatha", "Agnes", "Aileen", "Aimee", "Ainsley", "Aisha", "Alana", "Alberta",
    "Alejandra", "Alena", "Alexa", "Alexis", "Alina", "Alix", "Allegra", "Alma", "Althea", "Alva",
    "Alyssa", "Amara", "Amelie", "Anabel", "Anaya", "Angelica", "Angelina", "Angie", "Anika", "Annabel",
    "Annabelle", "Anne", "Annie", "Annika", "Antoinette", "Arabella", "Ariadne", "Ariel", "Arlene", "Ashlee",
    "Ashley", "Astrid", "Athena", "Aubrey", "Audra", "Audrey", "Augusta", "Aviana", "Ayla", "Azalea",
    "Beatrice", "Beatrix", "Becca", "Becky", "Belinda", "Belle", "Berenice", "Bernadette", "Bernice", "Bertha",
    "Bess", "Betsy", "Betty", "Blanche", "Blythe", "Bobbie", "Bonita", "Braelyn", "Brandi", "Bree",
    "Brianna", "Bridgette", "Brie", "Briella", "Brigitte", "Brinley", "Bristol", "Britney", "Brooke", "Brynlee",
    "Cadence", "Caitlin", "Caitlyn", "Callie", "Camila", "Camille", "Candi", "Caprice", "Cara", "Carina",
    "Carissa", "Carlotta", "Carly", "Carmela", "Carolina", "Caroline", "Carrie", "Cassidy", "Catalina", "Catharine",
    "Cathy", "Cecile", "Celina", "Chandra", "Charity", "Charlene", "Charley", "Charmaine", "Chelsea", "Cheri",
    "Cheryl", "Christa", "Christina", "Christy", "Ciara", "Clara", "Clarice", "Claudia", "Clementine", "Cleo",
    "Colette", "Connie", "Cordelia", "Corinne", "Cornelia", "Cristina", "Daisy", "Dakota", "Dana", "Daniela",
    "Daria", "Darla", "Deanna", "Debbie", "Debra", "Deidre", "Deirdre", "Delia", "Delilah", "Della",
    "Demi", "Desiree", "Destiny", "Devyn", "Diamond", "Diane", "Dianna", "Dina", "Dolly", "Dora",
    "Doreen", "Dorothea", "Dulce", "Edie", "Effie", "Elisa", "Elise", "Eliza", "Ellen", "Eloise",
    "Elsa", "Elsie", "Elvira", "Emilia", "Emmaline", "Emmeline", "Enid", "Erin", "Ernestine", "Esme",
    "Esperanza", "Estelle", "Ethel", "Etta", "Eugenia", "Eulalia", "Eunice", "Evangeline", "Evie", "Faith",
    "Fatima", "Faye", "Felicity", "Fernanda", "Flora", "Francine", "Freda", "Freya", "Frida", "Gabriela",
    "Gabrielle", "Gemma", "Gigi", "Gillian", "Ginny", "Giovanna", "Giselle", "Glenda", "Goldie", "Greta",
    "Griselda", "Guadalupe", "Gwen", "Hadley", "Hannah", "Harmony", "Hattie", "Haven", "Hayley", "Heidi",
    "Helena", "Helene", "Henrietta", "Hester", "Hilda", "Honor", "Ida", "Ileana", "Ilene", "Imelda",
    "Imogen", "Ina", "Ines", "Iona", "Irma", "Isabel", "Isabelle", "Isadora", "Ivana", "Izabella",
    "Jaclyn", "Jana", "Janelle", "Janet", "Janice", "Janine", "Janna", "Jaya", "Jeanette", "Jeanie",
    "Jemima", "Jenna", "Jewel", "Jillian", "Joanna", "Jodie", "Johanna", "Joni", "Josephine", "Josie",
    "Journey", "Juana", "Judy", "Juliana", "Julianna", "Julie", "Juliet", "Juliette", "Juniper", "Justine",
    "Kaia", "Kaitlyn", "Kala", "Kamila", "Kara", "Karina", "Karla", "Karly", "Katelyn", "Katharine",
    "Katherine", "Kathryn", "Katie", "Kayla", "Kaylee", "Keely", "Keira", "Kelley", "Keri", "Kerry",
    "Khloe", "Kiara", "Kiera", "Kimber", "Kimberly", "Kinsley", "Kira", "Kirsten", "Kitty", "Kora",
    "Krista", "Kristin", "Krystal", "Kyla", "Kylie", "Kyra", "Lacey", "Lainey", "Lana", "Lara",
    "Larissa", "Latasha", "Latoya", "Lauralee", "Laverne", "Lavinia", "Lea", "Leanne", "Leia", "Leila",
    "Leilani", "Lenora", "Leona", "Leslie", "Leticia", "Lexie", "Leyla", "Lia", "Liana", "Libby",
    "Liberty", "Liesel", "Lila", "Liliana", "Lillie", "Lina", "Lindsay", "Lisette", "Liv", "Livia",
    "Liza", "Lizette", "Lola", "Lolita", "Lorelei", "Lorena", "Loretta", "Lottie", "Lourdes", "Luciana",
    "Lucinda", "Luella", "Luisa", "Lupita", "Luz", "Lyla", "Lynda", "Lynette", "Lynn", "Lynnette",
    "Mabel", "Macy", "Madalyn", "Maddison", "Madeleine", "Madeline", "Madge", "Mae", "Maeve", "Maggie",
    "Magnolia", "Maisie", "Makayla", "Mallory", "Mandi", "Mandy", "Mara", "Maree", "Margaux", "Margo",
    "Margot", "Marguerite", "Mari", "Marian", "Mariana", "Marietta", "Marigold", "Marina", "Marisa", "Marisol",
    "Marissa", "Marjorie", "Marlena", "Marley", "Marquita", "Martina", "Mathilde", "Matilda", "Mattie", "Maude",
    "Maura", "McKenna", "Meadow", "Meg", "Melanie", "Melinda", "Melody", "Mercy", "Meredith", "Meryl",
    "Michaela", "Michele", "Mikaela", "Mikayla", "Mildred", "Millie", "Mina", "Minerva", "Minnie", "Mirabel",
    "Misty", "Moira", "Mona", "Muriel", "Myra", "Myrna", "Myrtle", "Nadia", "Nannette", "Natalia",
    "Nellie", "Nettie", "Neve", "Nia", "Nicole", "Nina", "Nita", "Noelle", "Nola", "Nomi",
    "Noreen", "Octavia", "Odette", "Olga", "Olive", "Opal", "Ophelia", "Paloma", "Pandora", "Patience",
    "Patsy", "Patti", "Paulette", "Paulina", "Petra", "Philippa", "Pilar", "Pippa", "Polly", "Poppy",
    "Portia", "Prudence", "Queenie", "Rachael", "Ramona", "Raven", "Reagan", "Renata", "Rhea", "Rhiannon",
    "Rhoda", "Rochelle", "Rosalind", "Rosalinda", "Rosalyn", "Rosanna", "Roseann", "Rosella", "Rosemary", "Rosetta",
    "Rosie", "Rowena", "Roxana", "Ruthie", "Rylee", "Sabina", "Sadie", "Saffron", "Saige", "Salome",
    "Sandy", "Saoirse", "Sara", "Sasha", "Savanna", "Savannah", "Selene", "Selma", "Seraphina", "Serena",
    "Shana", "Shania", "Shanice", "Shannon", "Sharlene", "Shay", "Shayla", "Sheena", "Shelly", "Sheri",
    "Sherri", "Sherry", "Sierra", "Sigrid", "Siobhan", "Skye", "Skylar", "Sloane", "Sondra", "Sonya",
    "Sophie", "Stacey", "Stevie", "Sunny", "Susanna", "Susanne", "Suzanne", "Sybil", "Sylvie", "Tabitha",
    "Talia", "Tallulah", "Tameka", "Tami", "Tania", "Taryn", "Tatiana", "Tatyana", "Tawny", "Tegan",
    "Terra", "Terri", "Tessa", "Tessie", "Thea", "Thelma", "Thomasina", "Tia", "Tiara", "Tilda",
    "Tillie", "Toni", "Tonya", "Tori", "Tracey", "Treasure", "Tricia", "Trina", "Trisha", "Trista",
    "Trudy", "Uma", "Una", "Valeria", "Venetia", "Verena", "Verity", "Vicky", "Viola", "Viviana",
    "Vivienne", "Willa", "Wilma", "Winnie", "Wren", "Wynne", "Xena", "Yael", "Yasmin", "Yolanda",
    "Zelda", "Zena", "Zinnia", "Zoey", "Zora", "Abbott", "Abrams", "Acevedo", "Acker", "Acosta",
    "Adair", "Adkins", "Aguilar", "Aguirre", "Akers", "Albers", "Aldrich", "Alexandre", "Alford", "Allard",
    "Almeida", "Alston", "Altman", "Alvarez", "Amato", "Ames", "Anders", "Andrade", "Angelo", "Archambault",
    "Arden", "Arena", "Arias", "Arroyo", "Ashby", "Ashford", "Ashworth", "Atkins", "Atkinson", "Avila",
    "Ayers", "Baca", "Bachman", "Bacon", "Baer", "Baez", "Bagley", "Bain", "Baird", "Baldwin",
    "Ballard", "Banks", "Bannon", "Barclay", "Barlow", "Barnes", "Baron", "Barrera", "Barrington", "Barron",
    "Bartlett", "Barton", "Bass", "Bassett", "Bauer", "Baumann", "Baxter", "Beach", "Beale", "Bean",
    "Beard", "Beasley", "Beck", "Becker", "Beckham", "Beckwith", "Bedford", "Bell", "Bellamy", "Bender",
    "Benn", "Berger", "Berman", "Bernstein", "Berry", "Bertrand", "Best", "Bevins", "Bianchi", "Biggs",
    "Bird", "Birch", "Blackburn", "Blackmon", "Blackwood", "Blanchard", "Bland", "Blankenship", "Blanton", "Bliss",
    "Block", "Bloom", "Bloomberg", "Blue", "Blunt", "Boggs", "Bond", "Bonilla", "Bonner", "Booker",
    "Boone", "Borden", "Boren", "Bowers", "Bowman", "Boyce", "Boyd", "Boyer", "Boyle", "Brack",
    "Bradford", "Bradshaw", "Brand", "Brandt", "Branson", "Brantley", "Braun", "Bray", "Brenner", "Bridges",
    "Bright", "Brody", "Brook", "Browne", "Browning", "Bryan", "Buchanan", "Buckley", "Buckner", "Bullock",
    "Bunch", "Bundy", "Burch", "Burden", "Burgess", "Burnham", "Burr", "Burroughs", "Burrows", "Busby",
    "Bush", "Butler", "Butts", "Byrd", "Byrne", "Cabrera", "Cage", "Cagle", "Cain", "Calder",
    "Callahan", "Calloway", "Camacho", "Camp", "Campos", "Cantu", "Caputo", "Cardenas", "Carey", "Carlisle",
    "Carney", "Cartwright", "Caruso", "Case", "Cash", "Castaneda", "Castellanos", "Castillo", "Castro", "Cates",
    "Cavanaugh", "Cervantes", "Chadwick", "Chamberlain", "Chaney", "Chang", "Chaplin", "Chen", "Cherry", "Choi",
    "Church", "Churchill", "Clancy", "Clanton", "Clapp", "Clarkson", "Clements", "Clifton", "Cline", "Coates",
    "Cobb", "Cochran", "Coffey", "Cohen", "Colbert", "Cole", "Coleman", "Collier", "Collings", "Compton",
    "Conley", "Connelly", "Connolly", "Conrad", "Contreras", "Conway", "Coolidge", "Copeland", "Corbett", "Corcoran",
    "Cordova", "Corley", "Cormier", "Corona", "Corrigan", "Costa", "Costello", "Cotton", "Coulter", "Cowan",
    "Craft", "Crane", "Craven", "Creighton", "Crews", "Crockett", "Cromwell", "Crow", "Crowder", "Crowley",
    "Crum", "Cruse", "Cuevas", "Cummings", "Curran", "Curry", "Daly", "Davenport", "Davidson", "Dawkins",
    "Day", "Delacruz", "Deleon", "Delgado", "Dempsey", "Denton", "Devereaux", "Devine", "Devlin", "Dickey",
    "Dickson", "Dixon", "Dodd", "Dodson", "Doherty", "Dolan", "Dominguez", "Donnelly", "Donohue", "Dooley",
    "Dorsey", "Dougherty", "Dow", "Dowling", "Downey", "Downs", "Doyle", "Draper", "Drummond", "Drury",
    "Dudley", "Duff", "Duffy", "Dugan", "Dunbar", "Dunham", "Dunlap", "Dunning", "Dupont", "Durham",
    "Dwyer", "Dyer", "Eagan", "Earle", "Easley", "Eason", "Eaton", "Edmonds", "Edmondson", "Elkins",
    "Ellington", "Elliott", "Ellsworth", "Emery", "Enright", "Ericsson", "Ernst", "Escalante", "Escobar", "Esparza",
    "Espinosa", "Estes", "Ethridge", "Ewing", "Faber", "Fahey", "Fairbanks", "Falcone", "Falk", "Fanning",
    "Farber", "Faria", "Farmer", "Farnsworth", "Farr", "Farrar", "Farris", "Faulk", "Faulkner", "Faust",
    "Fay", "Feldman", "Felton", "Fenwick", "Ferrell", "Fields", "Finch", "Findley", "Finnegan", "Fitzpatrick",
    "Flanagan", "Flannery", "Flinch", "Flood", "Foley", "Fontaine", "Forbes", "Forester", "Forrester", "Fortune",
    "Fowler", "Foy", "Freed", "Fry", "Fuentes", "Fulton", "Gable", "Gaffney", "Gaines", "Galbraith",
    "Gale", "Galindo", "Gallegos", "Galloway", "Gamble", "Garber", "Garner", "Garza", "Gates", "Gauthier",
    "Gay", "Gibbons", "Gifford", "Gilmore", "Gladstone", "Glass", "Gleason", "Godwin", "Goetz", "Goldberg",
    "Golden", "Goldstein", "Goodwin", "Goodrich", "Gorman", "Gould", "Grafton", "Granger", "Graves", "Greenfield",
    "Greer", "Gresham", "Grier", "Grimes", "Grogan", "Grooms", "Grove", "Groves", "Guerra", "Guest",
    "Guillen", "Gunn", "Gupta", "Guthrie", "Haas", "Haddad", "Hager", "Haggerty", "Haley", "Halliday",
    "Halsey", "Hamblin", "Hamby", "Hamlin", "Hammer", "Hancock", "Haney", "Hanley", "Hanlon", "Harding",
    "Harrell", "Harrington", "Hartley", "Hartman", "Haskins", "Hatch", "Hathaway", "Hatton", "Havel", "Hawk",
    "Hawthorne", "Hay", "Hays", "Haywood", "Healy", "Hedges", "Hefner", "Heller", "Helm", "Hemphill",
    "Hendricks", "Henley", "Hennessy", "Herndon", "Herrera", "Herring", "Hewitt", "Hickman", "Hidalgo", "Hilliard",
    "Hilton", "Hinton", "Hodge", "Hodges", "Holbrook", "Holcomb", "Holloway", "Holman", "Holton", "Hooper",
    "Hoover", "Hopkins", "Hopper", "Horn", "Horne", "Horowitz", "Hoskins", "Houghton", "Houser", "Howe",
    "Howley", "Hsu", "Hudgins", "Huff", "Huffman", "Huntley", "Hurst", "Hutchins", "Hyde", "Ingalls",
    "Ingersoll", "Inman", "Irvin", "Irvine", "Isaacs", "Isbell", "Iverson", "Ives", "Jacobsen", "Jacques",
    "Jaeger", "Jamison", "Jansen", "Janssen", "Jarrett", "Jenkins", "Jeter", "Jimenez", "Johns", "Jolley",
    "Jorgensen", "Juarez", "Judd", "Kaiser", "Kaplan", "Katz", "Kaufman", "Kearney", "Keating", "Keenan",
    "Keller", "Kellogg", "Kenney", "Kern", "Kidd", "Kilgore", "Kimball", "Kincaid", "Kinney", "Kirby",
    "Kirkland", "Kirkpatrick", "Kitchens", "Kline", "Knapp", "Knight", "Knowles", "Koch", "Kowalski", "Kraft",
    "Kraus", "Krueger", "Kuhn", "Kumar", "Ladd", "Lam", "Lamb", "Lancaster", "Landers", "Landis",
    "Lanier", "Larkin", "Larsen", "Lasalle", "Law", "Lawler", "Lawson", "Layne", "Leach", "Leal",
    "Leary", "Leblanc", "Ledford", "Ledger", "Lehman", "Levy", "Lim", "Link", "Linton", "Livingston",
    "Lockhart", "Lockwood", "Lodge", "Lofton", "Lombardi", "Loomis", "Love", "Lovett", "Lowell", "Lowery",
    "Lowry", "Lugo", "Lund", "Lundberg", "Lutz", "Lydon", "Lyman", "Lyon", "Macdonald", "Mackenzie",
    "Mackey", "Madden", "Madigan", "Maguire", "Mahoney", "Maloney", "Mancini", "Manley", "Manson", "Marble",
    "Marchand", "Marino", "Markham", "Marlow", "Marquis", "Martel", "Marx", "Massey", "Masters", "Mathews",
    "Mathis", "Matos", "Matthews", "Mattson", "Maynard", "Mayo", "Mays", "McAdams", "McAllister", "McBride",
    "McCain", "McCall", "McCarthy", "McClellan", "McConnell", "McCormick", "McCray", "McCullough", "McDowell", "McElroy",
    "McFarland", "McGill", "McGinnis", "McGrath", "McGregor", "McGuire", "McIntosh", "McIntyre", "McKay", "McKee",
    "McKinley", "McKinney", "McLain", "McLaughlin", "McMillan", "McNabb", "McNally", "McNamara", "McNeil", "McPherson",
    "Meade", "Medina", "Meier", "Mejia", "Melendez", "Melton", "Mendez", "Merchant", "Merrill", "Merritt",
    "Metz", "Meyers", "Middleton", "Millard", "Mills", "Milner", "Minor", "Mixon", "Mohr", "Molina",
    "Molinari", "Monahan", "Montoya", "Mooney", "Moran", "Moreau", "Moreland", "Moreno", "Morrison", "Morrow",
    "Morse", "Mosely", "Moser", "Mosley", "Mott", "Moyer", "Mullen", "Mullin", "Munoz", "Murdoch",
    "Murdock", "Nagel", "Nagle", "Nance", "Napier", "Navarro", "Naylor", "Needham", "Neff", "Nesbit",
    "Nesbitt", "Nester", "Neumann", "Newcomb", "Newell", "Newkirk", "Newman", "Nichols", "Nicholson", "Nielsen",
    "Niles", "Nixon", "Norberg", "Norton", "Norwood", "Novak", "Nunez", "O'Brien", "O'Connell", "O'Connor",
    "O'Donnell", "O'Leary", "O'Malley", "O'Neill", "O'Reilly", "Oakes", "Ochoa", "Odell", "Odom", "Ogden",
    "Oglesby", "Olsen", "Olson", "Oneill", "Oneil", "Ong", "Orozco", "Orr", "Ortega", "Osborn",
    "Ostrowski", "Otero", "Overstreet", "Pace", "Pacheco", "Pack", "Padgett", "Pagan", "Park", "Parham",
    "Parke", "Parkin", "Parks", "Parrish", "Parsons", "Partridge", "Paschal", "Patten", "Patterson", "Patton",
    "Paulson", "Paxton", "Peabody", "Peace", "Peck", "Pelletier", "Pemberton", "Pendleton", "Penner", "Peoples",
    "Pereira", "Perrin", "Petersen", "Petrocelli", "Petty", "Pham", "Phelps", "Pickett", "Pierson", "Pike",
    "Pina", "Pinkerton", "Pinkham", "Pinto", "Pipkin", "Pitts", "Plant", "Platt", "Plummer", "Poe",
    "Pollack", "Pollard", "Pollock", "Ponce", "Poore", "Portillo", "Potter", "Potts", "Pound", "Powell",
    "Pratt", "Prescott", "Prichard", "Pringle", "Pruitt", "Pryor", "Pugh", "Pulido", "Putnam", "Qualls",
    "Quarles", "Quick", "Quigley", "Quinlan", "Quintana", "Quintero", "Quiroz", "Raines", "Rainey", "Raleigh",
    "Rand", "Rangel", "Rankin", "Ratliff", "Rawlings", "Read", "Reardon", "Reddy", "Redmond", "Reeder",
    "Rees", "Reeves", "Regan", "Reilly", "Reinhardt", "Rempel", "Rendon", "Rhodes", "Richards", "Richter",
    "Riddick", "Riddle", "Rider", "Ridge", "Ridley", "Riggs", "Rios", "Ritchie", "Ritter", "Rivers",
    "Roach", "Robles", "Rocha", "Rock", "Rockwell", "Rodgers", "Roe", "Romano", "Rooney", "Root",
    "Rosas", "Rosen", "Rosenberg", "Rosenthal", "Roth", "Rothschild", "Rountree", "Rourke", "Rouse", "Rowland",
    "Royce", "Rubio", "Rucker", "Rudd", "Rue", "Ruffin", "Rush", "Russo", "Rutherford", "Rutledge",
    "Salas", "Salinas", "Salmon", "Sampson", "Sanborn", "Sanderson", "Sandoval", "Sanford", "Santana", "Santoro",
    "Sargent", "Saxon", "Saxton", "Saylor", "Scanlon", "Scarborough", "Schaefer", "Schafer", "Schiller", "Schmidt",
    "Schmitt", "Schofield", "Schreiber", "Schroeder", "Schultz", "Schumacher", "Schwab", "Scully", "Selby", "Self",
    "Sellers", "Serrano", "Sessions", "Seward", "Sexton", "Shaffer", "Shea", "Shelley", "Shepard", "Shepherd",
    "Sheppard", "Shields", "Short", "Shultz", "Silva", "Silverman", "Simpson", "Sims", "Sinclair", "Singleton",
    "Sisk", "Skelton", "Skinner", "Small", "Smart", "Smiley", "Snow", "Snyder", "Solis", "Somers",
    "Sorensen", "Sorenson", "Sosa", "Souza", "Sparks", "Spaulding", "Spears", "Speed", "Spence", "Spicer",
    "Springer", "Squires", "Stahl", "Stallings", "Stanford", "Starr", "Steel", "Stein", "Steinberg", "Stephenson",
    "Stern", "Sternberg", "Steves", "Stevenson", "Stiles", "Stinson", "Stoner", "Stout", "Stover", "Stowe",
    "Strickland", "Strong", "Stubbs", "Sturm", "Suarez", "Sumner", "Sutherland", "Swain", "Swan", "Sweeney",
    "Sweet", "Swift", "Sykes", "Sylvester", "Taber", "Talbot", "Tatum", "Temple", "Templeton", "Terrell",
    "Thacker", "Thatcher", "Thayer", "Thomason", "Thorpe", "Thurman", "Thurston", "Tibbetts", "Tierney", "Tilley",
    "Tillman", "Timmons", "Tolbert", "Toledo", "Tomlin", "Tomlinson", "Tompkins", "Toney", "Tran", "Trask",
    "Travers", "Trejo", "Trevino", "Trimble", "Tripp", "Trotter", "Trujillo", "Tully", "Tuttle", "Underhill",
    "Underwood", "Unger", "Upton", "Urban", "Valdez", "Valencia", "Valenzuela", "Valle", "Van Horn", "Vandenberg",
    "Vandyke", "Varner", "Vaughan", "Vazquez", "Vega", "Velasquez", "Velazquez", "Velez", "Vickers", "Villa",
    "Villarreal", "Villanueva", "Vogel", "Vogt", "Voss", "Wadsworth", "Wagner", "Wainwright", "Wakefield", "Walden",
    "Waller", "Wallin", "Walsh", "Walton", "Wang", "Waterman", "Watkins", "Watts", "Weatherly", "Weaver",
    "Webber", "Weber", "Weeks", "Weil", "Weinberg", "Weinstein", "Weir", "Weiss", "Weldon", "Weller",
    "Wells", "Welsh", "Wenger", "Westbrook", "Westfall", "Westmoreland", "Wetzel", "Whaley", "Whelan", "Whitehead",
    "Whitfield", "Whitley", "Whitman", "Whittaker", "Wick", "Wiggins", "Wilcox", "Wilder", "Wilkes", "Wilkinson",
    "Willard", "Wilmoth", "Winchester", "Winslow", "Wiseman", "Witherspoon", "Womack", "Wong", "Woodard", "Woodruff",
    "Woods", "Wooten", "Workman", "Worley", "Worth", "Worthington", "Wray", "Wu", "Wynn", "Yang",
    "Yarbrough", "Yeager", "Yi", "Youngblood", "Yu", "Yuen", "Zamora", "Zamudio", "Zapata", "Zavala",
    "Zhang", "Zink", "Zuniga", "Aristotle", "Socrates", "Plato", "Confucius", "Cleopatra", "Caesar", "Nero",
    "Napoleon", "Roosevelt", "Eisenhower", "Clinton", "Obama", "Gandhi", "Mandela", "Voltaire", "Descartes", "Kant",
    "Hegel", "Nietzsche", "Freud", "Jung", "Machiavelli", "Bismarck", "Wellington", "Columbus", "Magellan", "Pizarro",
    "Bolivar", "Ataturk", "Lenin", "Stalin", "Mao", "Trotsky", "Khrushchev", "Gorbachev", "Merkel", "Trudeau",
    "Macron", "Charlemagne", "Genghis", "Tamerlane", "Saladin", "Suleiman", "Ferdinand", "Hannibal", "Spartacus", "Ramesses",
    "Tutankhamun", "Nefertiti", "Hatshepsut", "Xerxes", "Pericles", "Archimedes", "Euclid", "Pythagoras", "Hippocrates", "Herodotus",
    "Thucydides", "Ovid", "Cicero", "Seneca", "Constantine", "Justinian", "Ptolemy", "Avicenna", "Kepler", "Tycho",
    "Leibniz", "Fermat", "Euler", "Gauss", "Bernoulli", "Faraday", "Bohr", "Planck", "Schrodinger", "Heisenberg",
    "Dirac", "Feynman", "Oppenheimer", "Turing", "Babbage", "Lovelace", "Pasteur", "Jenner", "Lister", "Nightingale",
    "Salk", "Crick", "Mendel", "Linnaeus", "Humboldt", "Lamarck", "Lyell", "Wegener", "Sagan", "Penrose",
    "Godel", "Hilbert", "Riemann", "Fourier", "Lagrange", "Laplace", "Boltzmann", "Carnot", "Farenheit", "Celsius",
    "Watt", "Hertz", "Ampere", "Ohm", "Joule", "Coulomb", "Volta", "Becquerel", "Fermi", "Pauling",
    "Michelangelo", "Donatello", "Botticelli", "Caravaggio", "Rembrandt", "Vermeer", "Monet", "Manet", "Renoir", "Degas",
    "Cezanne", "VanGogh", "Picasso", "Dali", "Matisse", "Kandinsky", "Mondrian", "Warhol", "Basquiat", "Banksy",
    "DaVinci", "Beethoven", "Mozart", "Bach", "Handel", "Haydn", "Schubert", "Chopin", "Liszt", "Verdi",
    "Puccini", "Dvorak", "Brahms", "Tchaikovsky", "Rachmaninoff", "Stravinsky", "Debussy", "Ravel", "Mahler", "Strauss",
    "Vivaldi", "Paganini", "Gershwin", "Copland", "Shakespeare", "Dickens", "Austen", "Bronte", "Tolstoy", "Dostoevsky",
    "Chekhov", "Twain", "Hemingway", "Steinbeck", "Orwell", "Kafka", "Woolf", "Keats", "Wordsworth", "Thoreau",
    "Melville", "Chaucer", "Wilde", "Yeats", "Ibsen", "Strindberg", "Brecht", "Moliere", "Racine", "Balzac",
    "Flaubert", "Zola", "Proust", "Camus", "Sartre", "Borges", "Marquez", "Neruda", "Nabokov", "Bulgakov",
    "Aberdeen", "Accra", "Ahmedabad", "Algiers", "Almaty", "Amman", "Anchorage", "Ankara", "Antwerp", "Apia",
    "Asheville", "Aspen", "Asuncion", "Auckland", "Baku", "Baltimore", "Bamako", "Bangalore", "Bangor", "Basel",
    "Beirut", "Belgrade", "Belmopan", "Bern", "Bilbao", "Birmingham", "Bishkek", "Boise", "Bologna", "Bordeaux",
    "Bratislava", "Bremen", "Brisbane", "Bruges", "Bucharest", "Buffalo", "Busan", "Canberra", "Cancun", "Capetown",
    "Caracas", "Cardiff", "Cartagena", "Casablanca", "Changsha", "Chattanooga", "Chengdu", "Chennai", "Christchurch", "Cincinnati",
    "Cleveland", "Cologne", "Cordoba", "Cork", "Curitiba", "Dakar", "Dammam", "Dar es Salaam", "Detroit", "Dhaka",
    "Doha", "Dortmund", "Dresden", "Dubrovnik", "Duluth", "Dundee", "Durban", "Dusseldorf", "Edinburgh", "Edmonton",
    "Eindhoven", "Fargo", "Fez", "Flagstaff", "Fortaleza", "Frankfurt", "Freetown", "Fresno", "Fukuoka", "Galway",
    "Gdansk", "Ghent", "Gibraltar", "Glasgow", "Gothenburg", "Grenoble", "Guadalajara", "Guangzhou", "Guatemala City", "Guayaquil",
    "Hague", "Halifax", "Hamburg", "Hanoi", "Harare", "Harrisburg", "Hartford", "Havana", "Heidelberg", "Hiroshima",
    "Hobart", "Honolulu", "Hyderabad", "Indianapolis", "Islamabad", "Jacksonville", "Jaipur", "Jakarta", "Johannesburg", "Kabul",
    "Kampala", "Karachi", "Kathmandu", "Kigali", "Kingston", "Kinshasa", "Kolkata", "Krakow", "Kuala Lumpur", "Kyoto",
    "Lagos", "Lahore", "Lausanne", "Leipzig", "Lille", "Limerick", "Liverpool", "Ljubljana", "Lodz", "Luanda",
    "Lucerne", "Lusaka", "Macau", "Macon", "Malaga", "Managua", "Manchester", "Manila", "Maputo", "Marrakech",
    "Marseille", "Medellin", "Melbourne", "Merida", "Milwaukee", "Minneapolis", "Minsk", "Mogadishu", "Monterrey", "Montevideo",
    "Montpellier", "Montreal", "Montreux", "Mombasa", "Nairobi", "Nanjing", "Naples", "Nashville", "Nassau", "Newcastle",
    "Nice", "Nicosia", "Norfolk", "Nuremberg", "Oakland", "Odessa", "Omaha", "Oran", "Osaka", "Ottawa",
    "Palermo", "Pamplona", "Panama City", "Perth", "Pittsburgh", "Porto", "Poznan", "Puebla", "Pune", "Pyongyang",
    "Quebec", "Quito", "Rabat", "Rangoon", "Reykjavik", "Richmond", "Riga", "Riyadh", "Rochester", "Rosario",
    "Rotterdam", "Sacramento", "Saigon", "Salzburg", "San Antonio", "San Diego", "San Jose", "San Juan", "San Salvador", "Sana",
    "Sapporo", "Sarajevo", "Seville", "Shenzhen", "Shreveport", "Siena", "Skopje", "Spokane", "Springfield", "Strasbourg",
    "Stuttgart", "Suva", "Syracuse", "Taipei", "Tallinn", "Tampa", "Tangier", "Tashkent", "Tbilisi", "Tegucigalpa",
    "Tehran", "Tijuana", "Tirana", "Toulouse", "Trieste", "Tripoli", "Tucson", "Tunis", "Turin", "Ulaanbaatar",
    "Uppsala", "Valletta", "Vancouver", "Venice", "Verona", "Vientiane", "Vilnius", "Waterloo", "Wuhan", "Wroclaw",
    "Xiamen", "Yerevan", "Yokohama", "Zagreb", "Zanzibar", "Abkhazia", "Acadia", "Alsace", "Andalusia", "Aragon",
    "Assam", "Asturia", "Bavaria", "Bengal", "Bermuda", "Bohemia", "Borneo", "Bosnia", "Burgundy", "Burma",
    "Byzantium", "Caledonia", "Canary Islands", "Carthage", "Castile", "Catalonia", "Ceylon", "Corsica", "Crete", "Crimea",
    "Dalmatia", "Flanders", "Galicia", "Gaul", "Greenland", "Guam", "Guernsey", "Gujarat", "Guyane", "Haiti",
    "Herzegovina", "Holstein", "Iberia", "Jersey", "Kashmir", "Kosovo", "Kurdistan", "Lapland", "Lombardy", "Lusitania",
    "Macedonia", "Manchuria", "Mauritius", "Mesopotamia", "Moldavia", "Moravia", "Navarre", "Normandy", "Nubia", "Oceania",
    "Palestine", "Patagonia", "Persia", "Phoenicia", "Piedmont", "Polynesia", "Pomerania", "Prussia", "Punjab", "Rajasthan",
    "Reunion", "Rhodesia", "Ruthenia", "Rwanda", "Sardinia", "Savoy", "Saxony", "Scandinavia", "Scotia", "Siberia",
    "Sicily", "Silesia", "Siam", "Sumatra", "Swabia", "Tasmania", "Thrace", "Tibet", "Transylvania", "Tuscany",
    "Tyrol", "Umbria", "Wallachia", "Wallonia", "Yorkshire", "Zealand", "Achilles", "Adonis", "Aegis", "Aeneas",
    "Aeolus", "Agamemnon", "Ajax", "Amaterasu", "Anubis", "Aphrodite", "Apollo", "Ares", "Artemis", "Bacchus",
    "Baldr", "Bastet", "Calypso", "Centaur", "Cerberus", "Ceres", "Charon", "Chimera", "Chronos", "Circe",
    "Daedalus", "Demeter", "Dionysus", "Electra", "Eros", "Europa", "Eurydice", "Fates", "Fortuna", "Gaia",
    "Hades", "Helios", "Hephaestus", "Hera", "Horus", "Hyperion", "Icarus", "Io", "Ishtar", "Isis",
    "Jason", "Janus", "Juno", "Lancelot", "Loki", "Maia", "Medea", "Medusa", "Midas", "Minotaur",
    "Morpheus", "Muse", "Narcissus", "Nyx", "Odysseus", "Olympus", "Orestes", "Orpheus", "Osiris", "Pan",
    "Pegasus", "Persephone", "Perseus", "Poseidon", "Prometheus", "Psyche", "Ra", "Ragnarok", "Romulus", "Sigurd",
    "Sphinx", "Styx", "Tantalus", "Theseus", "Titan", "Triton", "Tyr", "Valkyrie", "Vesta", "Vulcan",
    "Wotan", "Zephyr", "Arya", "Cersei", "Daenerys", "Tyrion", "Skyler", "Pinkman", "Eleven", "Demogorgon",
    "Schrute", "Byers", "Mulder", "Soprano", "Lannister", "Targaryen", "Baratheon", "Tyrell", "Greyjoy", "Arryn",
    "Martell", "Frey", "Mormont", "Clegane", "Varys", "Bronn", "Brienne", "Tormund", "Melisandre", "Missandei",
    "Theon", "Ramsay", "Joffrey", "Oberyn", "Littlefinger", "Hodor", "Sansa", "Shae", "Margaery", "Olenna",
    "Podrick", "Gendry", "Samwell", "Davos", "Batista", "Doakes", "LaGuerta", "Masuka", "Fring", "Salamanca",
    "Wexler", "Schrader", "Ehrmantraut", "Rajesh", "Wolowitz", "Koothrappali", "Hofstadter", "Doggett", "Picard", "Riker",
    "Worf", "Data", "Troi", "Crusher", "LaForge", "Spock", "Uhura", "Chekov", "Sulu", "Scotty",
    "Bones", "Sisko", "Janeway", "Chakotay", "Tuvok", "Neelix", "Saru", "Stamets", "Tilly", "Ripley",
    "Neo", "Trinity", "Corleone", "Vito", "Fredo", "Clemenza", "Hagen", "Tessio", "Barzini", "Sollozzo",
    "Tattaglia", "Gump", "Balboa", "Rambo", "Terminator", "Skynet", "Robocop", "Gladiator", "Iceman", "Goose",
    "Bourne", "Moneypenny", "Blofeld", "Jaws", "Drax", "Goldfinger", "Spectre", "Vesper", "Lecter", "Starling",
    "Voorhees", "Pinhead", "Pennywise", "Ghostface", "Shrek", "Donkey", "Farquaad", "Nemo", "Dory", "Marlin",
    "Crush", "Woody", "Buzz", "Lightyear", "Hamm", "Slinky", "Lotso", "Forky", "Olaf", "Moana",
    "Maui", "Raya", "Mulan", "Aladdin", "Pocahontas", "Rapunzel", "Tiana", "Cinderella", "Maleficent", "Gaston",
    "Scar", "Mufasa", "Nala", "Timon", "Pumbaa", "Rafiki", "Zazu", "Gollum", "Smeagol", "Legolas",
    "Gimli", "Aragorn", "Boromir", "Saruman", "Eowyn", "Faramir", "Samwise", "Pippin", "Merry", "Treebeard",
    "Bilbo", "Thorin", "Balin", "Thranduil", "Bard", "Smaug", "Azog", "Skywalker", "Kenobi", "Palpatine",
    "Windu", "Solo", "Chewbacca", "Lando", "Boba", "Jabba", "Tarkin", "Ahsoka", "Maul", "Dooku",
    "Grievous", "Kylo", "Ren", "Snoke", "Amidala", "Padme", "Anakin", "Mace", "Qui", "Gon",
    "Grogu", "Mandalorian", "Djarin", "Beatles", "Stones", "Zeppelin", "Sabbath", "Metallica", "Nirvana", "Radiohead",
    "Coldplay", "Oasis", "Queen", "Genesis", "Eagles", "Aerosmith", "Clapton", "Bowie", "Sinatra", "Presley",
    "Elvis", "Sinead", "Beyonce", "Rihanna", "Madonna", "Shakira", "Celine", "Aretha", "Billie", "Mariah",
    "Cher", "Parton", "Springsteen", "Jagger", "McCartney", "Cobain", "Bono", "Edge", "Morrissey", "Thom",
    "Yorke", "Vedder", "Cornell", "Staley", "Grohl", "Flea", "Slash", "Bonham", "Townshend", "Daltrey",
    "Gilmour", "Eno", "Bolan", "Iggy", "Pop", "Ramone", "Strummer", "Simonon", "Headon", "Rotten",
    "Vicious", "Marr", "Hook", "Depeche", "Erasure", "Smiths", "Cure", "Joy Division", "Kraftwerk", "Devo",
    "Blondie", "Talking Heads", "XTC", "Blur", "Albarn", "Gorillaz", "Arcade Fire", "Pixies", "R.E.M.", "Stipe",
    "Beastie", "Eminem", "Kanye", "Tupac", "Biggie", "Snoop", "Dre", "Nas", "Rakim", "Tang",
    "Clan", "Notorious", "Diddy", "OutKast", "Cardi", "Lizzo", "SZA", "Weeknd", "Ocean", "Chance",
    "Childish", "Gambino", "Pharrell", "Timbaland", "Missy", "Lauryn", "Fugees", "TLC", "Aaliyah", "Usher",
    "Gaga", "Bieber", "Sheeran", "Eilish", "Dua", "Lipa", "Post", "Doja", "Stallion", "Grande",
    "Miley", "Lovato", "Nicki", "Minaj", "Katy", "Pink", "Keys", "Blige", "Erykah", "Badu",
    "Sade", "Winehouse", "Janis", "Joplin", "LeBron", "Shaq", "Magic", "Garnett", "Nowitzki", "Durant",
    "Harden", "Giannis", "Antetokounmpo", "Kawhi", "Embiid", "Jokic", "Doncic", "Morant", "Lillard", "Bosh",
    "Messi", "Ronaldo", "Neymar", "Mbappe", "Haaland", "Benzema", "Modric", "Lewandowski", "Salah", "Mane",
    "DeBruyne", "Kante", "Son", "VanDijk", "Kroos", "Muller", "Neuer", "Zlatan", "Ibrahimovic", "Zidane",
    "Ronaldinho", "Rivaldo", "Romario", "Pele", "Maradona", "Platini", "Cruyff", "Beckenbauer", "Eusebio", "Puskas",
    "DiStefano", "Garrincha", "Maldini", "Baresi", "Federer", "Nadal", "Djokovic", "Sharapova", "Graf", "Sampras",
    "Agassi", "McEnroe", "Borg", "Connors", "Laver", "Hingis", "Navratilova", "Evert", "Billie Jean", "Mahomes",
    "Favre", "Elway", "Namath", "Unitas", "Brees", "Deion", "Payton", "Emmitt", "Dickerson", "OJ",
    "Rice", "Megatron", "Gronkowski", "Kelce", "Owens", "Staubach", "Aikman", "Babe", "Gehrig", "DiMaggio",
    "Mantle", "Griffey", "Trout", "Ohtani", "Kershaw", "Koufax", "Clemens", "Gretzky", "Lemieux", "Ovechkin",
    "McDavid", "Messier", "Hasek", "Jagr", "Yzerman", "Bourque", "Lidstrom", "Brodeur", "Sakic", "Selanne",
    "Forsberg", "Hull", "Esposito", "Bolt", "Ali", "Mayweather", "Pacquiao", "Foreman", "Holyfield", "DeLaHoya",
    "Canelo", "Fury", "Tiger", "Nicklaus", "Player", "Snead", "Mickelson", "Spieth", "McIlroy", "Koepka",
    "Rahm", "DeChambeau", "Wambach", "Rapinoe", "Carli", "Abby", "Vettel", "Raikkonen", "Verstappen", "Senna",
    "Prost", "Lauda", "Fangio", "Andretti", "Earnhardt", "Busch", "Acropolis", "Alhambra", "Angkor", "Alcatraz",
    "Bastille", "Buckingham", "Capitol", "Chernobyl", "Coliseum", "Kremlin", "Louvre", "Machu Picchu", "Matterhorn", "Niagara",
    "Notre Dame", "Pantheon", "Parthenon", "Pentagon", "Pompeii", "Reichstag", "Sistine", "Stonehenge", "Versailles", "Westminster",
    "Windsor", "Yellowstone", "Yosemite", "Trafalgar", "Tiananmen", "Brandenburg", "Bosphorus", "Suez", "Rushmore", "Lincoln Memorial",
    "Pearl Harbor", "Gettysburg", "Dunkirk", "Nagasaki", "Chichen Itza", "Easter Island", "Galapagos", "Barrier Reef", "Serengeti", "Vesuvius",
    "Krakatoa", "Babylon", "Olympia", "Delphi", "Ephesus", "Alexandria", "Constantinople", "Tenochtitlan", "Yale", "Princeton",
    "Columbia", "MIT", "Caltech", "Oxford", "Cambridge", "Berkeley", "UCLA", "USC", "NYU", "Georgetown",
    "Dartmouth", "Northwestern", "Vanderbilt", "Emory", "Tulane", "Fordham", "Loyola", "Villanova", "Marquette", "Gonzaga",
    "Baylor", "Ohio State", "Auburn", "Clemson", "Purdue", "BYU", "SMU", "TCU", "LSU", "Louisville",
    "Rutgers", "Sorbonne", "ETH", "Tsinghua", "Peking", "Imperial", "King's", "Queen's", "Bombay", "Technion",
    "Weizmann", "Hebrew University", "Interpol", "Europol", "NATO", "UNESCO", "UNICEF", "WHO", "IMF", "FBI",
    "CIA", "NSA", "MI5", "MI6", "Mossad", "KGB", "Scotland Yard", "Ivy League", "Accenture", "Airbus",
    "Alibaba", "Atlassian", "Baidu", "BlackRock", "Boeing", "Bosch", "BristolMyers", "Canon", "Caterpillar", "Chevron",
    "Cisco", "Citigroup", "Coinbase", "Comcast", "Cummins", "Daimler", "Deere", "Deloitte", "DoorDash", "Dropbox",
    "eBay", "Eli Lilly", "Equifax", "Etsy", "Exxon", "FedEx", "Fidelity", "GE", "General Electric", "Gillette",
    "GlaxoSmithKline", "Goldman", "Sachs", "Halliburton", "Heineken", "Hershey", "Hitachi", "Honda", "Honeywell", "Huawei",
    "Hyundai", "J.P.Morgan", "JetBlue", "Kawasaki", "Kia", "Kroger", "LG", "Lockheed", "Lululemon", "Lyft",
    "Marriott", "Mazda", "McKinsey", "Medtronic", "MetLife", "Michelin", "Mitsubishi", "Moderna", "Morgan Stanley", "Motorola",
    "Nokia", "Northrop", "Novartis", "Panasonic", "PayPal", "Pfizer", "Pinterest", "Procter", "Qualcomm", "Raytheon",
    "Reddit", "Rivian", "Roche", "Rolls Royce", "Roku", "SAP", "Shell", "Shopify", "Siemens", "Slack",
    "Snap", "Stripe", "Subaru", "Suzuki", "Tencent", "Twitch", "UPS", "Vanguard", "Verizon", "Vodafone",
    "Volkswagen", "Volvo", "Wayfair", "Wells Fargo", "Xiaomi", "Xerox", "Yahoo", "Yamaha", "Zillow", "Afrikaans",
    "Albanian", "Amharic", "Armenian", "Azerbaijani", "Basque", "Belarusian", "Bengali", "Bosnian", "Bulgarian", "Burmese",
    "Cantonese", "Catalan", "Cherokee", "Croatian", "Czech", "Danish", "Dutch", "Estonian", "Farsi", "Filipino",
    "Finnish", "Flemish", "Gaelic", "Georgian", "Guarani", "Gujarati", "Haitian", "Hausa", "Hawaiian", "Hungarian",
    "Icelandic", "Igbo", "Indonesian", "Irish", "Javanese", "Kannada", "Kazakh", "Khmer", "Korean", "Kurdish",
    "Kyrgyz", "Lao", "Latvian", "Lithuanian", "Luxembourgish", "Macedonian", "Malay", "Malayalam", "Maltese", "Mandarin",
    "Maori", "Marathi", "Mongolian", "Nepali", "Norwegian", "Pashto", "Persian", "Polish", "Punjabi", "Quechua",
    "Romanian", "Samoan", "Sanskrit", "Serbian", "Sinhalese", "Slovak", "Slovenian", "Somali", "Sundanese", "Swahili",
    "Swedish", "Tagalog", "Tamil", "Telugu", "Thai", "Tibetan", "Turkish", "Turkmen", "Ukrainian", "Urdu",
    "Uzbek", "Vietnamese", "Xhosa", "Yiddish", "Yoruba", "Zulu", "Anglo", "Celtic", "Nordic", "Slavic",
    "Baltic", "Mediterranean", "Polynesian", "Melanesian", "Micronesian", "Berber", "Bedouin", "Romani", "Sephardi", "Ashkenazi",
    "Mizrahi", "Druze", "Coptic", "Maronite", "Yazidi", "Champagne", "Chianti", "Merlot", "Cabernet", "Chardonnay",
    "Prosecco", "Riesling", "Cognac", "Scotch", "Bourbon", "Guinness", "Budweiser", "Smirnoff", "Bacardi", "Grey Goose",
    "Absolut", "Patron", "Espresso", "Cappuccino", "Latte", "Americano", "Macchiato", "Mocha", "Matcha", "Darjeeling",
    "Earl Grey", "Oolong", "Sencha", "Parmesan", "Cheddar", "Camembert", "Gouda", "Gruyere", "Mozzarella", "Roquefort",
    "Stilton", "Bolognese", "Carbonara", "Margherita", "Marinara", "Alfredo", "Pesto", "Ratatouille", "Couscous", "Hummus",
    "Tahini", "Falafel", "Shawarma", "Sushi", "Sashimi", "Ramen", "Tempura", "Teriyaki", "Wasabi", "Tofu",
    "Kimchi", "Bibimbap", "Pad Thai", "Satay", "Tikka", "Masala", "Tandoori", "Biryani", "Naan", "Samosa",
    "Croissant", "Baguette", "Brioche", "Eclair", "Macaron", "Souffle", "Crepe", "Quiche", "Fondue", "Strudel",
    "Pretzel", "Schnitzel", "Bratwurst", "Paella", "Gazpacho", "Churro", "Burrito", "Taco", "Quesadilla", "Empanada",
    "Ceviche", "Guacamole", "Jambalaya", "Gumbo", "Bisque", "Chowder", "Bruschetta", "Prosciutto", "Pancetta", "Gelato",
    "Tiramisu", "Cannoli", "Biscotti", "Baklava", "Halva", "Mochi", "Gyoza", "Wonton", "Dim Sum", "Ahab",
    "Bennet", "Bingley", "Darcy", "Eyre", "Fagin", "Gatsby", "Gulliver", "Hamlet", "Heathcliff", "Caulfield",
    "Huck", "Jekyll", "Karenina", "Macbeth", "Moriarty", "Oblomov", "Othello", "Prospero", "Quixote", "Raskolnikov",
    "Scrooge", "Shylock", "Kurtz", "Wonka", "Wickham", "Earnshaw", "Copperfield", "Twist", "Quasimodo", "Esmeralda",
    "Valjean", "Javert", "Cosette", "Fantine", "Frankenstein", "Dracula", "VanHelsing", "Renfield", "Stoker", "Poppins",
    "Baggins", "Snape", "Draco", "Malfoy", "Hagrid", "Lupin", "Sirius", "Dobby", "Longbottom", "Filch",
    "McGonagall", "Sprout", "Flitwick", "Slughorn", "Tonks", "Bellatrix", "Narcissa", "Weasley", "Lovegood", "Diggory",
    "Krum", "Fleur", "Delacour", "Grindelwald", "Newt", "Scamander", "Trelawney", "Luigi", "Peach", "Bowser",
    "Toad", "Yoshi", "Wario", "Waluigi", "Donkey Kong", "Ganondorf", "Pikachu", "Charizard", "Mewtwo", "Samus",
    "Aran", "Metroid", "Falco", "Captain Falcon", "Marth", "Ike", "Sonic", "Tails", "Knuckles", "Eggman",
    "Sephiroth", "Tifa", "Aerith", "Barret", "Squall", "Tidus", "Yuna", "Auron", "Vivi", "Noctis",
    "Lightning", "Kefka", "Croft", "Aloy", "Kratos", "Atreus", "Geralt", "Yennefer", "Triss", "Ciri",
    "Dandelion", "Tali", "Garrus", "Liara", "Wrex", "Mordin", "Thane", "Legion", "EDI", "Master Chief",
    "Cortana", "Arbiter", "Doom", "Doomguy", "Slayer", "Vergil", "Bayonetta", "Ryu", "Chun-Li", "Ken",
    "Akuma", "Guile", "Cammy", "Juri", "Scorpion", "Sub-Zero", "Raiden", "Liu Kang", "Johnny Cage", "Kitana",
    "Mileena", "Shao Kahn", "Pac-Man", "Tetris", "Megaman", "Protoman", "Zero", "Sigma", "Roll", "Snake",
    "Ocelot", "Otacon", "Big Boss", "Liquid", "Solidus", "Para-Medic", "Eevee", "Jigglypuff", "Greninja", "Lucario",
    "Incineroar", "Gengar", "Machamp", "Alakazam", "Dragonite", "Gyarados", "Lapras", "Snorlax", "Mew", "Rosalina",
    "Toadette", "Birdo", "Boo", "Kamek", "Koopa", "Marston", "Adler", "Hosea", "Lenny", "Escuella",
    "Bill", "Leopold", "Enderman", "Creeper", "Herobrine", "Notch", "Saharan", "Alpine", "Aegean", "Adriatic",
    "Caribbean", "Appalachian", "Ozark", "Smoky", "Cascade", "Sierra Nevada", "Mojave", "Gobi", "Kalahari", "Atacama",
    "Sonoran", "Namib", "Thar", "Taklamakan", "Karakum", "Tanami", "Chihuahuan", "Patagonian", "Nullarbor", "Outback",
    "Siberian", "Alaskan", "Canadian", "Australian", "African", "European", "American", "Mexican", "Brazilian", "Peruvian",
    "Chilean", "Colombian", "Argentinian", "Venezuelan", "Cuban", "Jamaican", "Puerto Rican", "Dominican", "Guatemalan", "Honduran",
    "Salvadoran", "Nicaraguan", "Panamanian", "Costa Rican", "Ecuadorian", "Bolivian", "Paraguayan", "Uruguayan", "British", "Scottish",
    "Northern Irish", "Cornish", "Manx", "Breton", "Galician", "Castilian", "Andalusian", "Provencal", "Tuscan", "Sicilian",
    "Sardinian", "Bavarian", "Prussian", "Swabian", "Austrian", "Swiss", "Walloon", "Frisian", "Scandinavian", "Norse",
    "Montenegrin", "Kosovar", "Iranian", "Iraqi", "Syrian", "Lebanese", "Jordanian", "Palestinian", "Israeli", "Egyptian",
    "Libyan", "Tunisian", "Algerian", "Moroccan", "Sudanese", "Ethiopian", "Kenyan", "Tanzanian", "Ugandan", "Rwandan",
    "Congolese", "Nigerian", "Ghanaian", "Senegalese", "Ivorian", "Malian", "Cameroonian", "Angolan", "Mozambican", "Zimbabwean",
    "Zambian", "Botswanan", "Namibian", "South African", "Malagasy", "Eritrean", "Djiboutian", "Mauritanian", "Swazi", "Pakistani",
    "Bangladeshi", "Sri Lankan", "Bhutanese", "Afghan", "Cambodian", "Laotian", "Malaysian", "Singaporean", "Bruneian", "Timorese",
    "Papuan", "Taiwanese", "Hong Konger", "Macanese", "Tongan", "Fijian", "Tahitian", "Aboriginal", "Indigenous", "Arduino",
    "Raspberry Pi", "Edison", "Marconi", "Pulitzer", "Cannes", "Sundance", "Tribeca", "Telluride", "SXSW", "Wimbledon",
    "Roland Garros", "Super Bowl", "World Series", "Champions League", "Europa League", "Copa America", "Premier League", "Bundesliga", "Serie A", "La Liga",
    "Ligue 1", "MLS", "NFL", "NBA", "MLB", "NHL", "FIFA", "UEFA", "IOC", "WADA",
    "ATP", "WTA", "PGA", "LPGA", "NASCAR", "Formula One", "Grand Prix", "Silverstone", "Monza", "Spa",
    "Suzuka", "Interlagos", "Jeddah",

];

  // יצירת מפה לחיפוש מהיר במיוחד (O(1))
  const NAME_MAP = new Map(PROPER_NOUNS_LIST.map(n => [n.toLowerCase(), n]));

  // קיצורים שנקודה אחריהם לא מסמנת סוף משפט
  const ABBREVIATIONS = new Set([
    'mr','mrs','ms','dr','jr','sr','prof','gen','sgt','lt','col','capt',
    'st','rev','gov','hon','no','vs','etc','dept','inc','corp','ltd','approx',
    'vol','ave','blvd','govt','est','assoc','bros','co','ft','mt','sgt'
  ]);

  // מילים שמופיעות ב-PROPER_NOUNS_LIST אבל הן גם מילים רגילות באנגלית
  // לא נהפוך אותן לאות גדולה אוטומטית כי ברוב ההקשרים הן לא שם פרטי
  const AMBIGUOUS_WORDS = new Set([
    // Legal Terms & Professional Titles — כולם מילים רגילות בדיאלוג
    'attorney','lawyer','partner','associate','subpoena','litigation','affidavit','deposition',
    'counselor','court','judge','officer','agent','detective','captain','sheriff',
    'professor','doctor','president','senator','governor','mayor','minister','chancellor',
    'director','executive','manager','chairman','general','colonel','major','sergeant','lieutenant',
    'justice','magistrate','prosecutor','defendant','plaintiff','bailiff','notary','solicitor',
    // שמות שהם גם מילים נפוצות
    'grace','rose','jade','ivy','ruby','violet','lily','willow','aria','piper',
    'hunter','mason','carter','cooper','baker','cook','turner','walker','miller','wright',
    'taylor','parker','brooks','angel','christian','roman','miles','nova','aurora',
    'autumn','hazel','reed','wood','hill','hall','ward','young','king','green',
    'white','gray','clay','wade','dean','earl','duke','grant','dale','don','pat',
    'sue','drew','art','penny','eve','dawn','joy','hope','pearl','crystal',
    'amber','heather','holly','iris','carol','june','paige','virginia','sally','ruth',
    'frank','warren','sterling','ray','lance','glenn','heath','jay','max','pierce','nick',
    'rex','perry','homer','otto',
    'stone','burns','fox','long','sharp','chase','cross','fisher','french','frost',
    'fuller','gross','hale','hardy','hood','lane','marsh','moody','moss','noble',
    'page','price','rich','savage','stark','wise','wolf','cannon','carpenter','brewer',
    'freeman','barker','powers','poole','valentine','drake','meadows','marks',
    // חודשים/עונות כפעלים
    'may','march','spring','summer','fall','winter',
    // כיוונים
    'north','south','east','west',
    // טבע/מדע — מילים נפוצות
    'sun','moon','earth','gold','silver','iron','mercury','cloud','node','server','database',
    'evolution','quantum','cosmos',
    // מילים כלליות נפוצות
    'world','national','international','modern','history',
    'university','college','academy','institute','union','federation','alliance','organization',
    'apple','amazon','target'
  ]);

  let overlay = null, popup = null, sentencePopup = null, lastText = '', currentSubtitleText = '';
  const subtitleHistory = [], sentenceTranslationCache = new Map();
  const sessionGlossary = new Map();
  let subtitleIdCounter = 0, currentSubtitleId = null;
  let lastHost = null;

  function toSentenceCase(text) {
    if (!text || text !== text.toUpperCase()) return text;

    // 0) תיקון סימני פיסוק שנדדו לתחילת השורה (בעיית BIDI על מערכת RTL)
    text = text.replace(/(^|\n)\s*([?!.,:;]+)\s*/g, (m, pre, punct, offset) => {
      // אם סימן הפיסוק בתחילת שורה — מחפשים את סוף השורה ומעבירים אותו לשם
      return pre;
    });
    // גרסה שמעבירה ימינה: בכל שורה, אם מתחילה בפיסוק, מעבירים לסוף
    text = text.split('\n').map(line => {
      const match = line.match(/^(\s*)([?!.,:;]+)(\s*)(.*)/);
      if (match) return match[1] + match[4] + match[2];
      return line;
    }).join('\n');

    let s = text.toLowerCase();

    // 1) אות גדולה בתחילת כל שורה (כולל ציטוט/סוגר אופציונלי)
    s = s.replace(/(^|\n)\s*(['"\(\[]?)([a-z])/g, (m, pre, q, ch) => pre + q + ch.toUpperCase());

    // 2) אות גדולה אחרי ! או ? (כולל ציטוט אופציונלי)
    s = s.replace(/([!?]+)\s+(['"]?)([a-z])/g, (m, p, q, ch) => p + ' ' + q + ch.toUpperCase());

    // 3) טיפול חכם בנקודות — לא להפוך אות גדולה אחרי קיצורים
    //    3a) שלוש נקודות (...) = סוף משפט → אות גדולה
    s = s.replace(/\.{2,}\s+(['"]?)([a-z])/g, (m, q, ch) => '... ' + q + ch.toUpperCase());
    //    3b) נקודה בודדת — בדיקה אם המילה לפניה היא קיצור
    s = s.replace(/\b([a-z]+)\.\s+(['"]?)([a-z])/g, (m, word, q, ch) => {
      if (ABBREVIATIONS.has(word)) return word + '. ' + q + ch;
      return word + '. ' + q + ch.toUpperCase();
    });

    // 4) הפיכת הקיצורים עצמם לאות גדולה (mr. → Mr.)
    s = s.replace(/\b(mr|mrs|ms|dr|jr|sr|prof|gen|sgt|lt|col|capt|st|rev|gov|hon)\./g,
      (m, abbr) => abbr.charAt(0).toUpperCase() + abbr.slice(1) + '.');

    // 5) תיקון I עצמאי ו-I' (I'm, I'll, I've, I'd)
    s = s.replace(/\bi\b/g, 'I').replace(/\bi'/g, "I'");

    // 6) שמות פרטיים מה-NAME_MAP, תוך דילוג על מילים דו-משמעיות
    s = s.replace(/\b[a-z]+\b/g, word => {
      if (AMBIGUOUS_WORDS.has(word)) return word;
      return NAME_MAP.get(word) || word;
    });

    return s;
  }

  function lineEndsSentence(text) {
    return /[.!?…]["')\]]*$/.test(text.trim());
  }

  function preserveLineStartCase(text) {
    return text.replace(/^(\s*['"\(\[]?)([A-Za-z])/, (match, prefix, firstChar, offset, fullText) => {
      const rest = fullText.slice(prefix.length);
      const firstWordMatch = rest.match(/^([A-Za-z]+(?:'[A-Za-z]+)?)/);
      const firstWord = firstWordMatch ? firstWordMatch[1].toLowerCase() : '';

      if (!firstWord) return match;
      if (firstWord === 'i' || firstWord.startsWith("i'")) return match;
      if (ABBREVIATIONS.has(firstWord)) return match;
      if (NAME_MAP.has(firstWord) && !AMBIGUOUS_WORDS.has(firstWord)) return match;

      return prefix + firstChar.toLowerCase();
    });
  }

  function shouldTreatAsContinuation(previousLine, currentRawLine) {
    const trimmedCurrent = currentRawLine.trim();
    if (!previousLine || !trimmedCurrent) return false;
    if (lineEndsSentence(previousLine)) return false;
    if (/^[-–—]/.test(trimmedCurrent)) return false;
    if (trimmedCurrent !== trimmedCurrent.toUpperCase()) return false;
    return true;
  }

  function normalizeSubtitleBlock(text) {
    const rawLines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line);

    const normalizedLines = rawLines.map(line => toSentenceCase(line));

    for (let index = 1; index < normalizedLines.length; index++) {
      if (shouldTreatAsContinuation(normalizedLines[index - 1], rawLines[index])) {
        normalizedLines[index] = preserveLineStartCase(normalizedLines[index]);
      }
    }

    return normalizedLines;
  }

  function getHost() { return document.fullscreenElement || document.body; }

  // הצמדת אלמנט קיים למארח הנוכחי — העברה, לא יצירה מחדש.
  // קודם נוצר אלמנט חדש בכל מעבר מסך-מלא והישן נשאר תלוי ב-body עם הכתובית האחרונה בתוכו;
  // הוא כבר לא התעדכן ולא נוקה, ולכן נתקע על המסך ו"נעלם" רק במסך מלא (שם מוצג רק תת-העץ שלו).
  function attachToHost(el, host) {
    if (el.parentElement !== host) {
      el.style.position = host === document.body ? 'fixed' : 'absolute';
      host.appendChild(el);
    }
    return el;
  }

  function ensureOverlay() {
    const host = getHost();
    if (overlay) return attachToHost(overlay, host);
    overlay = document.createElement('div');
    overlay.id = 'tm-disney-subtitle-overlay';
    Object.assign(overlay.style, {
      position: host === document.body ? 'fixed' : 'absolute',
      left: '8%', right: '8%', bottom: settings.overlayBottom + '%', zIndex: '2147483647',
      textAlign: 'center', fontSize: overlayFontExpr(), lineHeight: '1.25',
      color: '#fff', textShadow: '0 3px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,1)',
      fontFamily: 'Arial, sans-serif', fontWeight: '700', pointerEvents: 'auto', whiteSpace: 'pre-line', userSelect: 'none',
      direction: 'ltr', unicodeBidi: 'plaintext'
    });
    host.appendChild(overlay);
    overlay.addEventListener('click', handleWordClick);
    return overlay;
  }

  function ensurePopup(id, width) {
    const host = getHost();
    let el = document.getElementById(id);
    if (el) return attachToHost(el, host);
    el = document.createElement('div');
    el.id = id;
    Object.assign(el.style, {
      position: host === document.body ? 'fixed' : 'absolute', zIndex: '2147483647',
      width: `min(${width}px, 94vw)`, padding: '20px 22px', borderRadius: '14px',
      background: 'linear-gradient(180deg, rgba(15,15,20,0.99), rgba(5,5,10,0.99))',
      color: '#fff', boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
      border: '1px solid rgba(255,255,255,0.12)', borderTop: '3px solid #0063e5',
      fontFamily: 'Arial, sans-serif', display: 'none', pointerEvents: 'auto', backdropFilter: 'blur(15px)',
      direction: 'ltr', unicodeBidi: 'plaintext'
    });
    host.appendChild(el);
    return el;
  }

  function showPopup(el) {
    el.style.display = 'block';
    el.classList.remove('tm-popup-show');
    void el.offsetWidth;
    el.classList.add('tm-popup-show');
  }

  function hidePopup(el) {
    el.style.opacity = '0';
    el.style.transform = 'scale(0.96)';
    el.style.transition = 'opacity 0.12s ease, transform 0.12s ease';
    setTimeout(() => {
      el.style.display = 'none';
      el.style.opacity = '';
      el.style.transform = '';
      el.style.transition = '';
      el.classList.remove('tm-popup-show');
    }, 120);
  }

  function hideOriginalSubtitles() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes tm-fadeIn {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes tm-pulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 1; }
      }
      @keyframes tm-shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }

      /* מסתירים רק את שכבת הציור של הכתוביות — לא כפתורי "אודיו וכתוביות" שגם הם מכילים subtitle בשם המחלקה */
      [class*="subtitle-renderer" i], [class*="dss-subtitle" i], [class*="timedtext" i],
      [class*="caption-window" i], [class*="closed-caption" i] { opacity: 0 !important; }
      video::cue { opacity: 0; visibility: hidden; }

      .tm-word { cursor: pointer; border-radius: 6px; padding: 0 2px; transition: all 0.15s ease; display: inline-block; }
      .tm-word:hover { background: rgba(255,255,255,0.15); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(255,255,255,0.4); transform: translateY(-1px); }
      .tm-word:active { background: rgba(0,99,229,0.25); }

      .tm-close { position: absolute; top: 8px; right: 10px; cursor: pointer; opacity: 0.5; font-size: 18px; width: 28px; height: 28px; text-align: center; border-radius: 50%; transition: all 0.15s ease; line-height: 28px; }
      .tm-close:hover { opacity: 1; background: rgba(255,255,255,0.1); }

      .tm-btn { margin-top: 16px; padding: 12px 20px; border-radius: 10px; border: 1px solid #333; border-left: 3px solid #0063e5; background: #141414; color: #fff; cursor: pointer; font-size: 18px; font-weight: 600; transition: all 0.15s ease; display: flex; align-items: center; gap: 8px; }
      .tm-btn:hover { background: #222; box-shadow: 0 0 12px rgba(0,99,229,0.25); border-color: #555; border-left-color: #0063e5; }
      .tm-btn:active { transform: scale(0.97); }

      .tm-popup-show { animation: tm-fadeIn 0.2s ease-out; }
      .tm-loading { animation: tm-pulse 1.5s ease-in-out infinite; }
      .tm-shimmer-line { height: 14px; border-radius: 6px; background: linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.06) 75%); background-size: 200% 100%; animation: tm-shimmer 1.5s ease-in-out infinite; margin-bottom: 8px; }
      .tm-shimmer-line:last-child { width: 60%; }
      .tm-def-group { margin-bottom: 10px; }
      .tm-def-group:last-child { margin-bottom: 0; }
      .tm-def-text { line-height: 1.45; }
      .tm-def-number { color: #666; margin-right: 4px; font-size: 0.85em; }
      .tm-error { color: #ff6b6b; font-size: 24px; padding: 10px 0; direction: ltr; }
      .tm-error::before { content: '\\26A0  '; }

      .tm-sentence-history {
        direction: rtl;
        text-align: right;
        width: 100%;
        font-size: 30px;
        line-height: 1.6;
        margin-bottom: 18px;
        padding-bottom: 14px;
        border-bottom: 1px solid rgba(255,255,255,0.15);
      }
      .tm-sentence-history span { margin: 0 3px; display: inline; }
      .tm-sentence-current {
        direction: rtl;
        text-align: right;
        width: 100%;
        display: block;
        font-size: 44px;
        font-weight: 800;
        border-right: 5px solid #0063e5;
        padding-right: 15px;
        color: #fff;
        margin-top: 5px;
      }
    `;
    document.head.appendChild(style);
  }

  function applyDynamicStyles() {
    let dynStyle = document.getElementById('tm-dynamic-style');
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.id = 'tm-dynamic-style';
      document.head.appendChild(dynStyle);
    }
    const sfs = settings.sentencePopupFontScale;
    dynStyle.textContent = `
      .tm-sentence-history { font-size: ${Math.round(30 * sfs)}px !important; }
      .tm-sentence-current { font-size: ${Math.round(44 * sfs)}px !important; }
      #tm-word-popup { zoom: ${settings.wordPopupScale}; }
      #tm-settings-panel::-webkit-scrollbar { width: 8px; }
      #tm-settings-panel::-webkit-scrollbar-track { background: transparent; }
      #tm-settings-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border-radius: 4px; }
      #tm-settings-panel::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }
    `;
  }

  // =========================================================
  // החלפת שפת כתוביות — אנגלית (ללא CC) ⇄ עברית
  // =========================================================
  const SUB_LANGS = {
    en: { code: 'EN', label: 'אנגלית', prefixes: ['en'], names: ['אנגלית', 'english'] },
    he: { code: 'עב', label: 'עברית', prefixes: ['he', 'iw'], names: ['עברית', 'hebrew'] }
  };
  const CC_PATTERN = /\(cc\)|\[cc\]|\bcc\b|\bsdh\b|תיאור/i;

  let langSwitchBusy = false, lastKnownSubLang = 'en', langTickCounter = 0;

  // דיסני+ לא חושף API נגן יציב כמו נטפליקס — לכן עובדים מול textTracks של אלמנט הווידאו,
  // ואם אין רצועות זמינות נופלים לאוטומציה של תפריט "אודיו וכתוביות".
  function getPlayerVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    return vids.filter(v => v.readyState > 0 || v.currentSrc)[0] || vids[0] || null;
  }

  function usableTextTracks() {
    const video = getPlayerVideo();
    if (!video || !video.textTracks) return [];
    return Array.from(video.textTracks).filter(t => t.kind === 'subtitles' || t.kind === 'captions');
  }

  function isCCTrack(track) {
    if (track.kind === 'captions') return true;
    return CC_PATTERN.test(track.label || '');
  }

  function trackIsLang(track, lang) {
    const cfg = SUB_LANGS[lang];
    const bcp = String(track.language || '').toLowerCase();
    if (bcp) return cfg.prefixes.some(p => bcp === p || bcp.indexOf(p + '-') === 0);
    const name = String(track.label || '').toLowerCase();
    return cfg.names.some(n => name.indexOf(n) === 0);
  }

  // מונע מהדפדפן לצייר כתוביות native — במצב hidden ה-cues עדיין זמינים לקריאה
  function suppressNativeCues() {
    usableTextTracks().forEach(t => { if (t.mode === 'showing') t.mode = 'hidden'; });
  }

  // גיבוי לשאיבת הטקסט: אם דיסני מצייר כתוביות native ולא ב-DOM, קוראים ישירות מה-cues הפעילים
  function readActiveCueText() {
    const parts = [];
    usableTextTracks().forEach(track => {
      if (track.mode === 'disabled' || !track.activeCues) return;
      Array.from(track.activeCues).forEach(cue => {
        const t = String(cue.text || '').replace(/<[^>]+>/g, '').trim();
        if (t) parts.push(t);
      });
    });
    return parts.join('\n').trim();
  }

  // זיהוי השפה הפעילה: קודם דרך הרצועה הפעילה, אחרת לפי תווים עבריים בכתובית שעל המסך
  function detectSubLang() {
    const active = usableTextTracks().filter(t => t.mode !== 'disabled')[0];
    if (active) {
      if (trackIsLang(active, 'he')) return 'he';
      if (trackIsLang(active, 'en')) return 'en';
    }
    if (lastText) return /[֐-׿]/.test(lastText) ? 'he' : 'en';
    return lastKnownSubLang;
  }

  function setSubLangViaTextTracks(lang) {
    const tracks = usableTextTracks();
    if (!tracks.length) return false;
    const usable = tracks.filter(t => trackIsLang(t, lang));
    const track = usable.filter(t => !isCCTrack(t))[0] || usable[0];
    if (!track) return false;
    tracks.forEach(t => { if (t !== track) t.mode = 'disabled'; });
    track.mode = 'hidden';
    return true;
  }

  // כפתור פתיחת תפריט "אודיו וכתוביות" — דיסני+ מחליף שמות מחלקות בין גרסאות, לכן כמה מועמדים לפי סדר עדיפות
  const MENU_OPENER_SELECTORS = [
    '[data-testid="audio-subtitles-button"]',
    '[data-testid*="subtitle" i]',
    '[data-gv2elementkey*="audio" i]',
    'button[aria-label*="subtitle" i]',
    'button[aria-label*="כתוביות"]',
    'button[aria-label*="audio" i]',
    'button[title*="subtitle" i]'
  ];

  function subtitleMenuOpener() {
    for (let i = 0; i < MENU_OPENER_SELECTORS.length; i++) {
      const el = document.querySelector(MENU_OPENER_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  // פריטי רשימת השפות — מזוהים לפי הכותרת "כתוביות" ולא לפי class, כי הוא לא יציב בין גרסאות
  function subtitleMenuItems() {
    const heading = Array.from(document.querySelectorAll('h1, h2, h3, h4, [role="heading"], [class*="title" i]'))
      .filter(h => /^\s*(subtitles?|כתוביות)\s*$/i.test(h.textContent || ''))[0];
    const container = (heading && (heading.parentElement.querySelector('ul, [role="listbox"], [role="radiogroup"], [role="menu"]') || heading.parentElement))
      || document.querySelector('[data-testid*="subtitle" i] ul, [class*="subtitle-list" i], [role="radiogroup"]');
    if (!container) return [];
    return Array.from(container.querySelectorAll('li, button, [role="radio"], [role="option"], [role="menuitem"], [role="menuitemradio"]'));
  }

  function menuItemIsLang(item, lang) {
    const text = (item.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text || CC_PATTERN.test(text)) return false;
    if (/^(off|none|כבוי|ללא)$/i.test(text)) return false;
    return SUB_LANGS[lang].names.some(n => text === n || text.indexOf(n + ' ') === 0);
  }

  // גיבוי אם אין רצועות textTracks זמינות — הדמיית לחיצה בתפריט הכתוביות של דיסני+
  function setSubLangViaMenu(lang) {
    return new Promise(resolve => {
      const video = getPlayerVideo();
      if (video && video.parentElement) video.parentElement.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      const opener = subtitleMenuOpener();
      if (!opener) return resolve(false);
      opener.click();
      let tries = 0;
      const timer = setInterval(() => {
        const match = subtitleMenuItems().filter(item => menuItemIsLang(item, lang))[0];
        if (match) {
          clearInterval(timer);
          (match.querySelector('button, [role="radio"], [role="menuitem"], [role="menuitemradio"]') || match).click();
          setTimeout(() => { if (subtitleMenuItems().length) opener.click(); resolve(true); }, 150);
        } else if (++tries > 25) {
          clearInterval(timer);
          if (subtitleMenuItems().length) opener.click();
          resolve(false);
        }
      }, 100);
    });
  }

  function toggleSubtitleLang() {
    if (langSwitchBusy) return;
    const target = detectSubLang() === 'he' ? 'en' : 'he';
    langSwitchBusy = true;
    const done = setSubLangViaTextTracks(target) ? Promise.resolve(true) : setSubLangViaMenu(target);
    done.then(ok => {
      langSwitchBusy = false;
      if (ok) {
        lastKnownSubLang = target;
        // איפוס היסטוריה — כדי שהקשר התרגום לא יערבב שתי שפות
        subtitleHistory.length = 0;
        currentSubtitleId = null;
        lastText = '';
        const box = document.getElementById('tm-disney-subtitle-overlay');
        if (box) box.innerHTML = '';
      }
      updateLangButton(ok ? null : 'error');
    });
  }

  function updateLangButton(state) {
    const btn = document.getElementById('tm-lang-toggle');
    if (!btn) return;
    if (state === 'error') {
      btn.textContent = '✕';
      btn.title = 'לא נמצאה רצועת כתוביות מתאימה';
      btn.style.background = 'rgba(180,20,20,0.85)';
      setTimeout(() => { btn.style.background = 'rgba(30,30,30,0.7)'; updateLangButton(); }, 1500);
      return;
    }
    const target = detectSubLang() === 'he' ? 'en' : 'he';
    btn.textContent = SUB_LANGS[target].code;
    btn.title = 'החלף כתוביות ל' + SUB_LANGS[target].label + ' (Shift)';
  }

  // תרגום מהיר — משותף לכפתור 🌐 ולקיצור המקלדת M
  function triggerQuickTranslate() {
    if (!currentSubtitleId || !subtitleHistory.length) return;
    showSentencePopup(ensureOverlay().getBoundingClientRect());
  }

  function ensureSettingsUI() {
    const host = getHost();

    // כפתור גלגל שיניים
    let gear = document.getElementById('tm-settings-gear');
    if (!gear || !host.contains(gear) || gear.dataset.tmVersion !== SCRIPT_VERSION) {
      if (gear) gear.remove();
      gear = document.createElement('div');
      gear.id = 'tm-settings-gear';
      gear.textContent = '⚙';
      Object.assign(gear.style, {
        position: host === document.body ? 'fixed' : 'absolute',
        top: '80px', right: '20px', zIndex: '2147483647',
        width: '56px', height: '56px', borderRadius: '50%',
        background: 'rgba(30,30,30,0.7)', color: '#fff',
        fontSize: '32px', lineHeight: '56px', textAlign: 'center',
        cursor: 'pointer', opacity: '0.6', transition: 'opacity 0.2s, transform 0.3s ease',
        pointerEvents: 'auto', userSelect: 'none'
      });
      gear.onmouseenter = () => { gear.style.opacity = '1'; gear.style.transform = 'rotate(30deg)'; };
      gear.onmouseleave = () => { gear.style.opacity = '0.6'; gear.style.transform = 'rotate(0deg)'; };
      gear.onclick = () => {
        const p = document.getElementById('tm-settings-panel');
        if (p) { if (p.style.display === 'none') showPopup(p); else hidePopup(p); }
      };
      gear.dataset.tmVersion = SCRIPT_VERSION;
      host.appendChild(gear);
    }

    // כפתור החלפת שפת כתוביות — מתחת לגלגל השיניים
    let langBtn = document.getElementById('tm-lang-toggle');
    if (!langBtn || !host.contains(langBtn) || langBtn.dataset.tmVersion !== SCRIPT_VERSION) {
      if (langBtn) langBtn.remove();
      langBtn = document.createElement('div');
      langBtn.id = 'tm-lang-toggle';
      Object.assign(langBtn.style, {
        position: host === document.body ? 'fixed' : 'absolute',
        top: '145px', right: '20px', zIndex: '2147483647',
        width: '56px', height: '56px', borderRadius: '50%',
        background: 'rgba(30,30,30,0.7)', color: '#fff',
        fontSize: '20px', fontWeight: 'bold', lineHeight: '56px', textAlign: 'center',
        cursor: 'pointer', opacity: '0.6', transition: 'opacity 0.2s, transform 0.3s ease, background 0.2s',
        pointerEvents: 'auto', userSelect: 'none',
        display: isOnPlayerPage() ? 'block' : 'none'
      });
      langBtn.onmouseenter = () => { langBtn.style.opacity = '1'; langBtn.style.transform = 'scale(1.1)'; };
      langBtn.onmouseleave = () => { langBtn.style.opacity = '0.6'; langBtn.style.transform = 'scale(1)'; };
      langBtn.onclick = () => toggleSubtitleLang();
      langBtn.dataset.tmVersion = SCRIPT_VERSION;
      host.appendChild(langBtn);
      updateLangButton();
    }

    // כפתור תרגום מהיר
    let translateBtn = document.getElementById('tm-translate-btn');
    if (!translateBtn || !host.contains(translateBtn)) {
      if (translateBtn) translateBtn.remove();
      translateBtn = document.createElement('div');
      translateBtn.id = 'tm-translate-btn';
      translateBtn.textContent = '🌐';
      Object.assign(translateBtn.style, {
        position: host === document.body ? 'fixed' : 'absolute',
        top: '80px', right: '85px', zIndex: '2147483647',
        width: '56px', height: '56px', borderRadius: '50%',
        background: 'rgba(30,30,30,0.7)', color: '#fff',
        fontSize: '32px', lineHeight: '56px', textAlign: 'center',
        cursor: 'pointer', opacity: '0.6', transition: 'opacity 0.2s, transform 0.3s ease',
        pointerEvents: 'auto', userSelect: 'none', display: 'none'
      });
      translateBtn.onmouseenter = () => { translateBtn.style.opacity = '1'; translateBtn.style.transform = 'scale(1.1)'; };
      translateBtn.onmouseleave = () => { translateBtn.style.opacity = '0.6'; translateBtn.style.transform = 'scale(1)'; };
      translateBtn.onclick = () => triggerQuickTranslate();
      host.appendChild(translateBtn);
    }

    // פאנל הגדרות
    let panel = document.getElementById('tm-settings-panel');
    if (!panel || !host.contains(panel) || panel.dataset.tmVersion !== SCRIPT_VERSION) {
      if (panel) panel.remove();
      panel = document.createElement('div');
      panel.id = 'tm-settings-panel';
      Object.assign(panel.style, {
        position: host === document.body ? 'fixed' : 'absolute',
        top: '210px', right: '20px', zIndex: '2147483647',
        width: '320px', padding: '22px', borderRadius: '16px',
        // תקרת גובה + גלילה — אחרת התחתית של הפאנל נחתכת במסכים נמוכים
        maxHeight: 'calc(100vh - 230px)', overflowY: 'auto', overscrollBehavior: 'contain',
        background: 'linear-gradient(180deg, rgba(15,15,20,0.97), rgba(5,5,10,0.97))',
        color: '#fff', boxShadow: '0 15px 50px rgba(0,0,0,0.7)',
        border: '1px solid rgba(255,255,255,0.15)',
        fontFamily: 'Arial, sans-serif', display: 'none',
        pointerEvents: 'auto', backdropFilter: 'blur(15px)',
        direction: 'rtl'
      });

      const sliders = [
        { label: 'גודל כתוביות', key: 'overlayFontSize', min: 1, max: 6, step: 0.5, suffix: 'vw' },
        { label: 'גובה כתוביות', key: 'overlayBottom', min: 5, max: 45, step: 1, suffix: '%' },
        { label: 'גודל חלונית מילה', key: 'wordPopupScale', min: 0.5, max: 2, step: 0.1, suffix: '×' },
        { label: 'רוחב חלונית תרגום', key: 'sentencePopupWidth', min: 500, max: 1400, step: 50, suffix: 'px' },
        { label: 'גודל טקסט תרגום', key: 'sentencePopupFontScale', min: 0.5, max: 2, step: 0.1, suffix: '×' },
        { label: 'הגברת שמע', key: 'audioBoost', min: 1, max: AUDIO_MAX_BOOST, step: 0.1, suffix: '×' }
      ];

      let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <span style="cursor:pointer;opacity:0.7;font-size:20px;" id="tm-settings-close">×</span>
        <span style="font-size:18px;font-weight:bold;">⚙ הגדרות תצוגה <span style="font-size:11px;opacity:0.45;font-weight:normal;">v${SCRIPT_VERSION}</span></span>
      </div>`;

      sliders.forEach(s => {
        const val = settings[s.key];
        html += `<div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px;">
            <span class="tm-setting-val" data-key="${s.key}">${val}${s.suffix}</span>
            <span>${s.label}</span>
          </div>
          <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${val}"
            data-key="${s.key}" data-suffix="${s.suffix}"
            style="width:100%;accent-color:#0063e5;direction:ltr;">
        </div>`;
      });

      // מוצג רק אם הדפדפן חסם את ניתוב האודיו (ראה verifyAudioBoost)
      html += `<div id="tm-audio-note" style="display:none;margin:-6px 0 14px;padding:8px;border-radius:8px;background:rgba(180,20,20,0.2);border:1px solid rgba(180,20,20,0.5);font-size:12px;line-height:1.5;">הדפדפן חסם את הגברת השמע בתוכן המוגן. רענן את הדף (Ctrl+Shift+R) כדי להחזיר את הקול.</div>`;

      // --- בחירת מודל AI ---
      html += `<div style="margin-bottom:14px;">
        <div style="font-size:14px;margin-bottom:4px;text-align:right;">מודל AI</div>
        <select id="tm-ai-model" style="width:100%;padding:8px;border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#fff;font-size:14px;direction:ltr;">
          ${MODEL_OPTIONS.map(o => { const priceStr = o.price >= 1 ? '$' + o.price : '$' + o.price.toFixed(2); return `<option value="${o.key}"${settings.aiModel===o.key?' selected':''}>${o.label} — ${priceStr}/1M</option>`; }).join('')}
        </select>
      </div>`;

      // --- הקשר הסדרה ---
      html += `<div style="margin-bottom:14px;">
        <div style="font-size:14px;margin-bottom:4px;text-align:right;">הקשר הסדרה</div>
        <textarea id="tm-show-context" rows="3" style="width:100%;padding:8px;border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#fff;font-size:13px;resize:vertical;direction:ltr;font-family:Arial,sans-serif;"
          placeholder="e.g. The Mandalorian — Star Wars space western. Din Djarin (bounty hunter), Grogu, Greef Karga...">${settings.showContext}</textarea>
        <button id="tm-generate-context" style="width:100%;margin-top:6px;padding:8px;border-radius:10px;border:1px solid #444;background:#1a1a1a;color:#ccc;cursor:pointer;font-size:13px;">✨ ייצר הקשר בעזרת AI</button>
      </div>`;

      html += `<button id="tm-reset-settings" style="width:100%;margin-top:8px;padding:10px;border-radius:10px;border:1px solid #444;background:#1a1a1a;color:#fff;cursor:pointer;font-size:15px;font-weight:bold;">איפוס לברירת מחדל</button>`;

      panel.innerHTML = html;

      panel.querySelector('#tm-settings-close').onclick = () => hidePopup(panel);

      panel.querySelector('#tm-ai-model').addEventListener('change', e => {
        settings.aiModel = e.target.value;
        saveSettings();
      });

      panel.querySelector('#tm-show-context').addEventListener('input', e => {
        settings.showContext = e.target.value;
        saveSettings();
      });

      panel.querySelector('#tm-generate-context').addEventListener('click', () => {
        const popup = ensureContextGeneratorPopup();
        showPopup(popup);
        const host = getHost();
        const hostRect = host === document.body ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : host.getBoundingClientRect();
        popup.style.left = `${Math.max(20, (hostRect.width - popup.offsetWidth) / 2)}px`;
        popup.style.top = `${Math.max(40, (hostRect.height - popup.offsetHeight) / 2)}px`;
      });

      panel.querySelectorAll('input[type="range"]').forEach(input => {
        input.addEventListener('input', () => {
          const key = input.dataset.key;
          const suffix = input.dataset.suffix;
          settings[key] = parseFloat(input.value);
          panel.querySelector(`.tm-setting-val[data-key="${key}"]`).textContent = input.value + suffix;
          saveSettings();
          applyDynamicStyles();
          if (key === 'overlayFontSize' && overlay) {
            overlay.style.fontSize = overlayFontExpr();
          }
          if (key === 'overlayBottom' && overlay) {
            overlay.style.bottom = settings.overlayBottom + '%';
          }
          if (key === 'sentencePopupWidth') {
            const el = document.getElementById('tm-sentence-popup');
            if (el) el.style.width = `min(${settings.sentencePopupWidth}px, 94vw)`;
          }
          if (key === 'audioBoost') applyAudioBoost();
        });
      });

      panel.querySelector('#tm-reset-settings').onclick = () => {
        const savedContext = settings.showContext;
        Object.assign(settings, SETTINGS_DEFAULTS);
        settings.showContext = savedContext;
        saveSettings();
        applyDynamicStyles();
        if (overlay) {
          overlay.style.fontSize = overlayFontExpr();
          overlay.style.bottom = settings.overlayBottom + '%';
        }
        const sp = document.getElementById('tm-sentence-popup');
        if (sp) sp.style.width = `min(${settings.sentencePopupWidth}px, 94vw)`;
        panel.querySelectorAll('input[type="range"]').forEach(inp => {
          const key = inp.dataset.key;
          const suffix = inp.dataset.suffix;
          inp.value = settings[key];
          panel.querySelector(`.tm-setting-val[data-key="${key}"]`).textContent = settings[key] + suffix;
        });
        const modelSel = panel.querySelector('#tm-ai-model');
        if (modelSel) modelSel.value = settings.aiModel;
        applyAudioBoost();
      };

      panel.dataset.tmVersion = SCRIPT_VERSION;
      host.appendChild(panel);
    }
    updateAudioBoostUI();
  }

  // =========================================================
  // AI SHOW CONTEXT GENERATOR
  // =========================================================
  function generateShowContext(showName) {
    return new Promise((resolve, reject) => {
      const systemPrompt = `You are a metadata assistant for a subtitle translation tool (English → Hebrew).
The user will give you a TV show or movie name. Generate a concise "show context" block that a translator can use to produce accurate, natural Hebrew subtitles.

Include:
- Show name, genre, setting/time period
- Main characters: name, role, key relationships (max 8-10 characters)
- Tone and dialogue style (e.g. witty legal banter, dark humor, casual slang)
- Key terminology or domain-specific jargon (legal, medical, sci-fi, etc.)
- Notable speech patterns, catchphrases, or recurring phrases

Keep it under 600 characters. Write in English. Be factual and concise — this is reference metadata, not a review.`;

      GM_xmlhttpRequest({
        method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        data: JSON.stringify({
          model: getModelOption().model, reasoning_effort: getModelOption().effort,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: showName }
          ]
        }),
        onload: function (r) {
          try {
            const text = JSON.parse(r.responseText).choices[0].message.content;
            resolve(text.trim());
          } catch (e) { reject(e); }
        },
        onerror: reject
      });
    });
  }

  function ensureContextGeneratorPopup() {
    const popup = ensurePopup('tm-context-generator', 520);
    popup.innerHTML = `
      <div style="direction:rtl;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:18px;font-weight:bold;">יצירת הקשר סדרה</span>
        <span id="tm-ctxgen-close" style="cursor:pointer;font-size:22px;opacity:0.6;padding:0 4px;">✕</span>
      </div>
      <input id="tm-ctxgen-input" type="text" placeholder="e.g. The Mandalorian, Loki, The Simpsons..."
        style="width:100%;padding:10px;border-radius:10px;border:1px solid #444;background:#1a1a1a;color:#fff;font-size:14px;box-sizing:border-box;direction:ltr;margin-bottom:10px;" />
      <button id="tm-ctxgen-generate" style="width:100%;padding:10px;border-radius:10px;border:1px solid #555;background:#2a2a2a;color:#fff;cursor:pointer;font-size:14px;font-weight:bold;">🔍 Generate Context</button>
      <div id="tm-ctxgen-status" style="text-align:center;margin-top:10px;font-size:13px;color:#aaa;display:none;"></div>
      <textarea id="tm-ctxgen-result" readonly rows="8" style="width:100%;margin-top:12px;padding:10px;border-radius:10px;border:1px solid #444;background:#111;color:#ddd;font-size:13px;resize:vertical;direction:ltr;font-family:Arial,sans-serif;box-sizing:border-box;display:none;"></textarea>
      <button id="tm-ctxgen-apply" style="width:100%;margin-top:10px;padding:10px;border-radius:10px;border:1px solid #4a9;
        background:#1a3a2a;color:#7fc;cursor:pointer;font-size:14px;font-weight:bold;display:none;">✅ החל על הקשר הסדרה</button>
    `;

    popup.querySelector('#tm-ctxgen-close').onclick = () => hidePopup(popup);

    popup.querySelector('#tm-ctxgen-generate').onclick = () => {
      const input = popup.querySelector('#tm-ctxgen-input');
      const status = popup.querySelector('#tm-ctxgen-status');
      const result = popup.querySelector('#tm-ctxgen-result');
      const applyBtn = popup.querySelector('#tm-ctxgen-apply');
      const showName = input.value.trim();
      if (!showName) {
        status.textContent = '⚠️ הכנס שם סדרה';
        status.style.display = 'block';
        return;
      }
      status.textContent = '⏳ מייצר הקשר...';
      status.style.display = 'block';
      result.style.display = 'none';
      applyBtn.style.display = 'none';

      generateShowContext(showName).then(text => {
        result.value = text;
        result.style.display = 'block';
        applyBtn.style.display = 'block';
        status.style.display = 'none';
      }).catch(() => {
        status.textContent = '❌ שגיאה ביצירת הקשר. נסה שוב.';
      });
    };

    popup.querySelector('#tm-ctxgen-apply').onclick = () => {
      const text = popup.querySelector('#tm-ctxgen-result').value;
      settings.showContext = text;
      saveSettings();
      const textarea = document.getElementById('tm-show-context');
      if (textarea) textarea.value = text;
      hidePopup(popup);
    };

    return popup;
  }

  function positionBox(box, anchorRect) {
    const host = getHost();
    const hostRect = host === document.body ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : host.getBoundingClientRect();
    // Horizontal — center on anchor word, clamped to edges
    let left = anchorRect.left - hostRect.left + anchorRect.width / 2 - box.offsetWidth / 2;
    left = Math.max(20, Math.min(left, hostRect.width - box.offsetWidth - 20));
    // Vertical — place above the subtitle overlay
    const overlayEl = document.getElementById('tm-disney-subtitle-overlay');
    const overlayTop = overlayEl
      ? overlayEl.getBoundingClientRect().top - hostRect.top
      : hostRect.height * 0.8;
    let top = overlayTop - box.offsetHeight - 20;
    if (top < 10) top = 10;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  function renderInteractiveSubtitle(text) {
    const box = ensureOverlay();
    const lines = text.split('\n');
    box.innerHTML = lines.map(line => {
      const parts = line.match(/([A-Za-z]+(?:'[A-Za-z]+)?)|([^A-Za-z]+)/g) || [];
      return parts.map(part => {
        if (/^[A-Za-z]+(?:'[A-Za-z]+)?$/.test(part)) return `<span class="tm-word" data-word="${part}">${part}</span>`;
        return part;
      }).join('');
    }).join('<br>');
  }

  function openAITranslate(contextLines) {
    return new Promise((resolve, reject) => {
      const cacheKey = JSON.stringify(contextLines);
      if (sentenceTranslationCache.has(cacheKey)) return resolve(sentenceTranslationCache.get(cacheKey));
      const padded = [...contextLines];
      while (padded.length < 9) padded.unshift('');

      // --- System prompt: expert audiovisual translator ---
      let systemPrompt = `You are an expert audiovisual translator specializing in English-to-Hebrew subtitle translation for Israeli viewers.

CORE RULES:
- Use natural spoken Hebrew (עברית מדוברת טבעית) — the way Israelis actually talk, not literary or formal register.
- NEVER translate literally. Always convey the INTENT and FEELING behind the words. If the original is funny, the translation must be funny. If it's threatening, it must feel threatening in Hebrew.
- Match the register and tone of the original: slang stays slang, formal stays formal, sarcasm stays sarcastic. A character who says "dude" should sound like "אחי", not "ידידי".
- Keep translations concise — subtitles must be readable in ~2 seconds. Avoid verbose or overly explanatory phrasing.
- Infer speaker gender from dialogue cues (names, pronouns, vocatives, context) and apply correct Hebrew verb/adjective conjugation.
- The 8 history lines (line_1 oldest → line_8 newest) provide narrative context. Use them for pronoun resolution, tone continuity, and consistent terminology. Translate ALL lines, not just the current one.
- Maintain consistent translation of recurring terms, character names, and domain-specific jargon across all lines.

IDIOMS, SLANG & FIGURATIVE LANGUAGE (CRITICAL):
When you encounter an English idiom, phrasal verb, slang expression, or figurative phrase — you MUST replace it with a natural Hebrew equivalent that carries the same meaning and feel. NEVER translate idioms word-for-word.

Step-by-step approach for figurative language:
1. Identify the expression as idiomatic/figurative
2. Understand the MEANING and EMOTION behind it
3. Find a Hebrew idiom, expression, or natural phrasing that conveys the same thing
4. If no perfect Hebrew idiom exists, paraphrase naturally — still NEVER translate literally

Always ask: "Would an Israeli say this?" If not, rephrase.

OUTPUT FORMAT:
Return STRICT JSON only with these keys:
- "line_1" through "line_8": Hebrew translations for history lines (oldest to newest). Omit keys for empty input lines.
- "line_current": Hebrew translation of the current (most recent) line.
- "glossary": Array of {"en": "...", "he": "..."} pairs for domain-specific terms, proper nouns, or recurring jargon that should be reused consistently in future translations. Include 0-5 entries only when genuinely useful.`;

      // Inject show context if configured
      if (settings.showContext && settings.showContext.trim()) {
        systemPrompt += `\n\n[SHOW CONTEXT]\n${settings.showContext.trim()}`;
      }

      // Inject accumulated glossary for consistency
      if (sessionGlossary.size > 0) {
        const glossaryEntries = Array.from(sessionGlossary.entries()).slice(-40)
          .map(([en, he]) => `${en} → ${he}`).join('\n');
        systemPrompt += `\n\n[GLOSSARY — use these established translations for consistency]\n${glossaryEntries}`;
      }

      const userPrompt = `line_1: ${padded[0]}
line_2: ${padded[1]}
line_3: ${padded[2]}
line_4: ${padded[3]}
line_5: ${padded[4]}
line_6: ${padded[5]}
line_7: ${padded[6]}
line_8: ${padded[7]}
line_current: ${padded[8]}`;

      GM_xmlhttpRequest({
        method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        data: JSON.stringify({
          model: getModelOption().model, reasoning_effort: getModelOption().effort, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
        }),
        onload: function (r) {
          try {
            const res = JSON.parse(JSON.parse(r.responseText).choices[0].message.content);
            // Extract glossary updates and merge into session glossary
            if (Array.isArray(res.glossary)) {
              res.glossary.forEach(entry => {
                if (entry && entry.en && entry.he) sessionGlossary.set(entry.en.toLowerCase(), entry.he);
              });
              delete res.glossary;
            }
            sentenceTranslationCache.set(cacheKey, res);
            resolve(res);
          } catch (e) { reject(e); }
        },
        onerror: reject
      });
    });
  }

  async function showSentencePopup(anchorRect) {
    const tip = ensurePopup('tm-sentence-popup', settings.sentencePopupWidth);
    const index = subtitleHistory.findIndex(x => x.id === currentSubtitleId);
    if (index === -1) return;
    const context = subtitleHistory.slice(Math.max(0, index - 8), index + 1).map(x => x.text);

    tip.innerHTML = `<div class="tm-close">×</div><div class="tm-sentence-current tm-loading">Translating...</div>`;
    showPopup(tip);
    positionBox(tip, anchorRect);
    tip.querySelector('.tm-close').onclick = () => hidePopup(tip);

    try {
      const trans = await openAITranslate(context);
      // היסטוריה כפסקה זורמת - 8 שורות עם מפריד ביניהן
      const historyParts = [];
      const historyLines = [];
      for (let i = 1; i <= 8; i++) {
        if (trans[`line_${i}`]) historyLines.push(trans[`line_${i}`]);
      }
      historyLines.forEach((line, idx) => {
        const opacity = (0.3 + (0.4 * idx / Math.max(historyLines.length - 1, 1))).toFixed(2);
        historyParts.push(`<span style="opacity:${opacity}">${line}</span>`);
      });
      const historyHtml = historyParts.length
        ? `<div class="tm-sentence-history">${historyParts.join(' ')}</div>` : '';
      const currentHtml = trans.line_current
        ? `<div class="tm-sentence-current">${trans.line_current}</div>` : '';

      tip.innerHTML = `<div class="tm-close">×</div>${historyHtml}${currentHtml}`;
      tip.querySelector('.tm-close').onclick = () => hidePopup(tip);
      positionBox(tip, anchorRect);
    } catch (e) { tip.innerHTML = `<div class="tm-close">×</div><div class="tm-error">${e.message}</div>`; tip.querySelector('.tm-close').onclick = () => hidePopup(tip); }
  }

  function handleWordClick(e) {
    const el = e.target.closest('.tm-word');
    if (!el) return;
    e.stopPropagation();
    const wordRect = el.getBoundingClientRect();
    const p = ensurePopup('tm-word-popup', 600);
    p.innerHTML = `<div class="tm-close">×</div><div style="margin-bottom:6px;"><span style="font-size:36px;font-weight:700;">${el.dataset.word.toLowerCase()}</span></div><div style="border-top:1px solid rgba(255,255,255,0.1);margin:8px 0 12px 0;"></div><div id="tm-def" style="font-size:22px;opacity:0.9;"><div class="tm-shimmer-line" style="width:90%"></div><div class="tm-shimmer-line" style="width:75%"></div><div class="tm-shimmer-line" style="width:60%"></div></div><button class="tm-btn"><span style="font-size:16px;">🌐</span> AI Translate Sentence</button>`;
    showPopup(p);
    positionBox(p, wordRect);
    p.querySelector('.tm-close').onclick = () => hidePopup(p);
    p.querySelector('.tm-btn').onclick = () => showSentencePopup(wordRect);
    fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(el.dataset.word.toLowerCase())}`)
      .then(res => res.json()).then(data => {
        const defEl = document.getElementById('tm-def');
        const defs = [];
        if (data[0] && Array.isArray(data[0].meanings)) {
          for (const meaning of data[0].meanings) {
            for (const d of (meaning.definitions || []).slice(0, 2)) {
              defs.push(d.definition);
              if (defs.length >= 3) break;
            }
            if (defs.length >= 3) break;
          }
        }
        if (defs.length) {
          defEl.innerHTML = defs.map((text, i) => {
            return `<div class="tm-def-group"><div class="tm-def-text" style="font-size:22px;"><span class="tm-def-number">${i+1}.</span>${text}</div></div>`;
          }).join('');
        } else {
          defEl.innerHTML = '<span style="opacity:0.5;">No definition found.</span>';
        }
        positionBox(p, wordRect);
      })
      .catch(() => { const defEl = document.getElementById('tm-def'); defEl.innerHTML = '<span style="opacity:0.5;">Definition unavailable.</span>'; });
  }

  // דיסני+ מחליף שמות מחלקות בין גרסאות, ולכן כלל CSS סטטי לא תמיד תופס את שכבת הכתוביות המקורית.
  // כאן מסתירים בפועל את האלמנט שממנו נשאב הטקסט (ואת מעטפת הרקע שלו) — opacity לא מפריע לקריאת innerText.
  // דיסני+ יוצר אלמנט חדש לכל כתובית, ולכן הסתרה נקודתית מגיעה תמיד טיק אחד מאוחר מדי —
  // הכתובית המקורית מהבהבת לרגע. לכן לצד ההסתרה הנקודתית מזריקים כלל CSS קבוע לפי שם המחלקה,
  // וכך גם אלמנט שייווצר בהמשך מוסתר כבר בציור הראשון שלו.
  const hideStyleByRoot = new Map();

  function installNativeHideRule(node) {
    const selector = classSelector(node);
    if (!selector) return;
    const root = node.getRootNode();
    let style = hideStyleByRoot.get(root);
    if (!style || !style.isConnected) {
      style = document.createElement('style');
      style.id = 'tm-native-hide';
      (root === document ? (document.head || document.documentElement) : root).appendChild(style);
      hideStyleByRoot.set(root, style);
    }
    const rule = selector + '{opacity:0 !important;}';
    if (style.textContent.indexOf(rule) === -1) style.textContent += rule;
  }

  // מטפסים מאלמנט הכתובית כלפי מעלה כל עוד ההורה מכיל אך ורק אותה, ומסתירים כל שלב בדרך.
  // זה הלב של תיקון ההבהוב: העטיפה החיצונית שורדת בין כתובית לכתובית, ולכן הסתרה שלה נשארת
  // בתוקף גם כשדיסני+ הורס ובונה מחדש את אלמנט הכתובית עצמו. מחזירים את העטיפה היציבה ביותר.
  function hideScrapedElement(el) {
    let node = el;
    for (let depth = 0; depth < 4; depth++) {
      if (node.style && node.style.opacity !== '0') node.style.setProperty('opacity', '0', 'important');
      installNativeHideRule(node);
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.querySelector('video')) break;
      if (parent.closest(INTERACTIVE_ANCESTORS) || parent.closest(CONTROLS_ANCESTORS)) break;
      if ((parent.innerText || '').trim() !== (node.innerText || '').trim()) break;
      node = parent;
    }
    return node;
  }

  // דיסני+ לא מסמן את שכבת הכתוביות בשם מחלקה יציב, ולפעמים היא לא מכילה "subtitle" בכלל.
  // לכן האיתור נעשה בשני שלבים: קודם לפי שם מחלקה (כולל shadow DOM), ואם אין — גיאומטרית:
  // בלוק טקסט קטן שיושב מעל הווידאו בחלקו התחתון, מחוץ לסרגל הבקרה.
  // אחרי איתור מוצלח ננעלים על סלקטור המחלקות, כדי שהלולאה של 100ms תישאר זולה.
  let lockedRoot = null, lockedSelector = '', lockedNode = null, discoverCounter = 0;

  function allRoots() {
    const roots = [document];
    const walk = root => {
      const els = root.querySelectorAll('*');
      for (let i = 0; i < els.length; i++) {
        if (els[i].shadowRoot) { roots.push(els[i].shadowRoot); walk(els[i].shadowRoot); }
      }
    };
    walk(document);
    return roots;
  }

  function textIsSubtitleLike(t) {
    if (!t || t.length >= 240) return false;
    if (TIMECODE_RE.test(t)) return false;              // "2:02:40" — שעון הנגן
    return /[A-Za-z֐-׿]/.test(t);            // כתובית חייבת להכיל אות
  }

  function isSubtitleCandidate(el, vr) {
    if (!el || el.nodeType !== 1 || !el.closest) return false;
    if (el.closest('[id^="tm-"]')) return false;                       // האוברליי והחלוניות שלנו
    if (el.closest(INTERACTIVE_ANCESTORS) || el.closest(CONTROLS_ANCESTORS)) return false;
    if (el.querySelector('video, ' + INTERACTIVE_ANCESTORS)) return false;
    if (!textIsSubtitleLike((el.innerText || '').trim())) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.height > vr.height * 0.4) return false;
    const centerY = r.top + r.height / 2;
    return centerY > vr.top + vr.height * 0.4 && centerY <= vr.bottom + 4
      && r.right > vr.left && r.left < vr.right;
  }

  function classSelector(el) {
    const classes = String(el.className || '').trim().split(/\s+/).filter(c => c && c.indexOf('tm-') !== 0);
    return classes.length ? '.' + classes.map(c => CSS.escape(c)).join('.') : '';
  }

  function discoverSubtitleNode() {
    const video = getPlayerVideo();
    if (!video) return null;
    const vr = video.getBoundingClientRect();
    if (vr.width < 200 || vr.height < 100) return null;

    // שלב א' — לפי שם מחלקה, בכל שורשי ה-DOM
    const roots = allRoots();
    for (let i = 0; i < roots.length; i++) {
      const hits = roots[i].querySelectorAll(SUBTITLE_SELECTOR);
      for (let j = 0; j < hits.length; j++) {
        if (isSubtitleCandidate(hits[j], vr)) return { root: roots[i], node: hits[j] };
      }
    }

    // שלב ב' — גיאומטרית, בתוך מכל הנגן
    let container = video;
    for (let i = 0; i < 6 && container.parentElement; i++) container = container.parentElement;
    const all = container.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (!isSubtitleCandidate(all[i], vr)) continue;
      // עולים למעלה כל עוד ההורה עדיין נראה ככתובית — כדי לתפוס בלוק של כמה שורות ולא שורה בודדת
      let node = all[i];
      while (node.parentElement && isSubtitleCandidate(node.parentElement, vr)) node = node.parentElement;
      return { root: node.getRootNode(), node: node };
    }
    return null;
  }

  // שאיבת הכתובית מה-DOM — קודם דרך הנעילה הקיימת, ורק אם אין — גילוי מחדש (יקר, לא בכל טיק)
  function scrapeSubtitleText() {
    let el = null;
    if (lockedNode && lockedNode.isConnected) el = lockedNode;
    if (!el && lockedRoot && lockedSelector) {
      try { el = lockedRoot.querySelector(lockedSelector); } catch (e) { el = null; }
    }
    if (!el) {
      if (++discoverCounter % 2 !== 0) return '';
      const found = discoverSubtitleNode();
      if (!found) return '';
      // ננעלים על העטיפה היציבה ולא על אלמנט הכתובית עצמו — הוא נהרס ונוצר מחדש בכל כתובית
      const wrapper = hideScrapedElement(found.node);
      lockedNode = wrapper;
      lockedRoot = wrapper.getRootNode();
      lockedSelector = classSelector(wrapper);
      el = wrapper;
    } else if (el.style && el.style.opacity !== '0') {
      el.style.setProperty('opacity', '0', 'important');
    }
    const t = (el.innerText || '').trim();
    return textIsSubtitleLike(t) ? t : '';
  }

  function tick() {
    const host = getHost();
    // מעבר מסך-מלא: מעבירים מיד את הכתובית למארח החדש כדי שלא תיעלם עד הכתובית הבאה
    if (host !== lastHost) { lastHost = host; ensureSettingsUI(); ensureOverlay(); }

    const langBtn = document.getElementById('tm-lang-toggle');
    if (langBtn) {
      const onWatch = isOnPlayerPage();
      langBtn.style.display = onWatch ? 'block' : 'none';
      // רענון התווית פעם בשנייה — כדי לשקף גם החלפה ידנית דרך תפריט דיסני+
      if (onWatch && !langSwitchBusy && ++langTickCounter % 10 === 0) updateLangButton();
    }

    suppressNativeCues();

    // קודם ה-cues של הווידאו — הם חד-משמעית כתוביות. שאיבה מה-DOM היא גיבוי, והיא זו שעלולה
    // לתפוס אלמנטים אחרים בנגן (כמו שעון הזמן שנותר), ולכן היא מסוננת בכבדות.
    let raw = readActiveCueText();
    if (raw.length >= 240) raw = '';
    if (!raw) raw = scrapeSubtitleText();
    if (!raw) {
      if (lastText) { ensureOverlay().innerHTML = ''; lastText = ''; }
      const tb = document.getElementById('tm-translate-btn');
      if (tb) tb.style.display = 'none';
      return;
    }
    const tb = document.getElementById('tm-translate-btn');
    if (tb) tb.style.display = 'block';
    if (raw !== lastText) {
      const normalizedLines = normalizeSubtitleBlock(raw);
      normalizedLines.forEach(line => {
        if (!subtitleHistory.length || subtitleHistory[subtitleHistory.length-1].text !== line) {
          subtitleHistory.push({ id: ++subtitleIdCounter, text: line });
          if (subtitleHistory.length > 150) subtitleHistory.shift();
        }
      });
      currentSubtitleId = subtitleHistory[subtitleHistory.length-1].id;
      renderInteractiveSubtitle(normalizedLines.join('\n'));
      lastText = raw;
    }
  }

  hideOriginalSubtitles();
  applyDynamicStyles();
  ensureSettingsUI();

  // Ensure the script initializes even if DOM is not ready
  function initializeWhenReady() {
    if (document.body) {
      // סגירת חלוניות — משותף למקש Escape ולקיצור N
      const openPopups = () => ['tm-word-popup', 'tm-sentence-popup', 'tm-settings-panel']
        .map(id => document.getElementById(id))
        .filter(el => el && el.style.display !== 'none');
      const closeOpenPopups = () => openPopups().forEach(hidePopup);
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeOpenPopups();
      });

      // קיצור מקלדת: הקשה בודדת על Shift מחליפה שפת כתוביות.
      // (Alt לא מתאים — כרום חוטף אותו לשורת התפריטים ואירוע השחרור לא מגיע לדף.)
      // הפעולה מתבצעת בשחרור המקש, ורק אם Shift נלחץ לבדו — כך Shift+חץ וצירופים אחרים לא מפעילים אותה.
      let shiftAlone = false;
      const inEditableField = el => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '');
      window.addEventListener('keydown', e => {
        if (e.key === 'Shift') {
          if (e.repeat) return;
          shiftAlone = !inEditableField(e.target) && isOnPlayerPage();
        } else {
          shiftAlone = false;
        }
      }, true);
      window.addEventListener('keyup', e => {
        if (e.key !== 'Shift' || !shiftAlone) return;
        shiftAlone = false;
        toggleSubtitleLang();
      }, true);
      window.addEventListener('mousedown', () => { shiftAlone = false; }, true);
      window.addEventListener('blur', () => { shiftAlone = false; });

      // קיצורי מקלדת: M מפעיל תרגום AI (זהה ללחיצה על כפתור 🌐), N סוגר חלונית פתוחה.
      // הבדיקה לפי e.code כדי שיעבוד גם בפריסת מקלדת עברית.
      // דיסני+ רושמת מאזין keydown משלה עוד לפני שהסקריפט נטען ועלולה לבלוע את האירוע,
      // ולכן ההפעלה מנוסה גם ב-keyup — אותו שלב שבו קיצור ה-Shift עובד.
      const isHotkey = (e, code, letter) =>
        (e.code === code || e.key === letter || e.key === letter.toUpperCase()) &&
        !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey &&
        !inEditableField(e.target) && !(e.target && e.target.isContentEditable) &&
        isOnPlayerPage();
      // N נתפס רק כשיש חלונית פתוחה — אחרת הוא ממשיך לנגן, שמשתמש בו לקיצור משלו
      const hotkeyAction = e => {
        if (isHotkey(e, 'KeyM', 'm')) return triggerQuickTranslate;
        if (isHotkey(e, 'KeyN', 'n') && openPopups().length) return closeOpenPopups;
        return null;
      };
      let hotkeyDownCode = '';
      window.addEventListener('keydown', e => {
        const action = hotkeyAction(e);
        if (!action) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        hotkeyDownCode = e.code;
        action();
      }, true);
      window.addEventListener('keyup', e => {
        const action = hotkeyAction(e);
        if (!action) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (hotkeyDownCode !== e.code) action();
        hotkeyDownCode = '';
      }, true);
      setInterval(tick, 100);
      setInterval(syncAudioBoost, 1000);
    } else {
      setTimeout(initializeWhenReady, 100);
    }
  }
  initializeWhenReady();
})();
