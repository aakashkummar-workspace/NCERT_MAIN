import type { Catalog } from "../catalog";

/**
 * The Hindi catalog.
 *
 * `satisfies Catalog` is the whole safety mechanism: `Catalog` is derived from
 * the English catalog, so a key missing here, a key spelled differently here,
 * or a plural message written as a plain string here is a compile error naming
 * the key. Without it a gap would ship as an empty element on a student's
 * phone, and nobody looks at the Hindi build.
 *
 * ---------------------------------------------------------------------------
 * Translated, not transliterated
 * ---------------------------------------------------------------------------
 * These are sentences a Hindi-medium Class 9 student reads without effort, not
 * word-for-word swaps of the English. Three places where they deliberately
 * diverge from the English:
 *
 *   - `signin.code.sentTo` ends with a colon, because the phone number that
 *     follows it on screen comes FIRST in the Hindi clause and the English
 *     preposition has nowhere to go.
 *   - `signin.code.validFor` has identical `one` and `other` forms, because
 *     मिनट is a loanword that does not inflect for number. Both are written
 *     out anyway: the plural mechanism is chosen by CLDR category, not by this
 *     file, and the next pluralised noun (कोशिश → कोशिशें) will inflect.
 *   - Familiar loanwords are kept in Devanagari — कोड, मोबाइल नंबर, मैसेज,
 *     सर्वर — because that is what a student actually says. Sanskritised
 *     replacements (संकेतांक for "code") are technically Hindi and are read by
 *     nobody.
 *
 * The interface is Hindi. The QUESTIONS ARE NOT: curriculum content is
 * authored by teachers in English on a shared, locale-free plane, and this
 * seam does not touch it. See the note at the top of `en-IN.ts`.
 */
export const hi = {
  // -- The page shell ------------------------------------------------------
  "signin.student.pageTitle": "विद्यार्थी साइन इन",
  "signin.title": "साइन इन करें",
  "signin.description":
    "वह मोबाइल नंबर डालें जो आपके शिक्षक ने आपके लिए दर्ज किया है। हम उसी नंबर पर कोड भेजेंगे।",
  "signin.teacherPrompt": "क्या आप शिक्षक हैं?",
  "signin.teacherLink": "यहाँ साइन इन करें",
  "signin.aside.headline":
    "आपके सभी टेस्ट एक ही जगह, और बचा हुआ समय हमेशा स्क्रीन पर।",
  "signin.aside.subtitle": "कक्षा 9 और 10।",

  // -- Signing in with a printed card --------------------------------------
  "signin.card.prompt": "क्या शिक्षक ने आपको साइन-इन कार्ड दिया है?",
  "signin.card.link": "कार्ड से साइन इन करें",
  "signin.card.pageTitle": "कार्ड से साइन इन",
  "signin.card.description":
    "अपने कार्ड पर छपा कोड लिखें, या फ़ोन के कैमरे से उसका QR कोड स्कैन करें।",
  "signin.card.label": "कार्ड कोड",
  "signin.card.hint": "बारह अक्षर और अंक। बीच के डैश लिखना ज़रूरी नहीं है।",
  "signin.card.checking": "आपके कार्ड से साइन इन हो रहा है…",
  "signin.card.sharedDevice": {
    one: "साझा कंप्यूटर पर काम ख़त्म होने पर साइन आउट करें। कार्ड से किया गया साइन इन {count} घंटे बाद अपने-आप भी ख़त्म हो जाता है।",
    other: "साझा कंप्यूटर पर काम ख़त्म होने पर साइन आउट करें। कार्ड से किया गया साइन इन {count} घंटे बाद अपने-आप भी ख़त्म हो जाता है।",
  },
  "signin.card.usePhone": "इसके बजाय मोबाइल नंबर से साइन इन करें",

  // -- Step one: the number ------------------------------------------------
  "signin.phone.label": "मोबाइल नंबर",
  "signin.phone.placeholder": "10 अंकों का मोबाइल नंबर",
  "signin.phone.submit": "कोड भेजें",
  "signin.phone.submitting": "भेजा जा रहा है…",

  // -- Step two: the code --------------------------------------------------
  "signin.code.label": "6 अंकों का कोड",
  "signin.code.validFor": {
    one: "यह कोड {count} मिनट तक चलेगा।",
    other: "यह कोड {count} मिनट तक चलेगा।",
  },
  "signin.code.submit": "साइन इन करें",
  "signin.code.submitting": "जाँच हो रही है…",
  "signin.code.sentTo": "अगर यह नंबर पंजीकृत है, तो इस नंबर पर कोड भेजा जा रहा है:",
  "signin.code.createdFor": "इस नंबर के लिए कोड बनाया गया:",
  "signin.code.change": "बदलें",

  // -- When the SMS gateway refused the message ----------------------------
  "signin.undelivered.title": "हम मैसेज नहीं भेज सके",
  "signin.undelivered.body":
    "कोड बन गया था, लेकिन हमारी मैसेज सेवा ने उसे स्वीकार नहीं किया। अपने शिक्षक से साइन इन करवाएँ, या कुछ मिनट बाद दोबारा कोशिश करें।",

  "signin.dev.notice":
    "सिर्फ़ डेवलपमेंट के लिए — आपका कोड {code} है। यह प्रोडक्शन में कभी नहीं दिखता।",
  "signin.dev.unregistered":
    "सिर्फ़ डेवलपमेंट के लिए — इस नंबर से कोई छात्र पंजीकृत नहीं है, इसलिए कोई कोड इससे साइन इन नहीं करेगा। किसी कक्षा की सूची का नंबर इस्तेमाल करें। यह प्रोडक्शन में कभी नहीं दिखता।",

  // -- Failures ------------------------------------------------------------
  "error.sendCode": "हम अभी कोड नहीं भेज सके। कृपया दोबारा कोशिश करें।",
  "error.network":
    "हम सर्वर तक नहीं पहुँच सके। अपना इंटरनेट कनेक्शन जाँचें और दोबारा कोशिश करें।",
  "error.badCode": "यह कोड काम नहीं आया।",

  // -- The student bar -----------------------------------------------------
  "student.skip": "मुख्य सामग्री पर जाएँ",
  "student.nav.practice": "अभ्यास",
  "student.nav.progress": "प्रगति",
  "student.nav.syllabus": "पाठ्यक्रम",
  "student.signOut": "साइन आउट",
  "student.language.label": "भाषा",
  "student.language.hint": "प्रश्न अंग्रेज़ी में ही रहेंगे।",
  "student.language.failed": "भाषा नहीं बदल सकी। दोबारा कोशिश करें।",

  // -- Home: the header and the tests --------------------------------------
  "home.hello": "नमस्ते, {name}",
  "home.intro.live": "आपके शिक्षक ने आपके लिए यह दिया है।",
  "home.intro.none":
    "अभी आपके लिए कुछ नहीं दिया गया है। जब आपके शिक्षक कोई टेस्ट देंगे, तो वह यहाँ दिखेगा।",
  "home.sectionFailed": "यह हिस्सा अभी लोड नहीं हो सका। पेज को दोबारा लोड करके देखें।",
  "home.tests.heading": "देने वाले टेस्ट",
  "home.tests.emptyTitle": "अभी कोई टेस्ट नहीं",
  "home.tests.emptyBody":
    "जब आपके शिक्षक आपकी कक्षा को कोई टेस्ट देंगे, तो वह यहाँ दिखेगा, साथ में उसे पूरा करने का समय भी। अगर शिक्षक ने कक्षा कोड दिया है, तो ऊपर उसका इस्तेमाल करें।",
  "home.tests.noneOpen":
    "अभी आपके लिए कोई टेस्ट खुला नहीं है। नया टेस्ट यहाँ दिखेगा, साथ में उसे पूरा करने का समय भी।",
  "home.test.open": "अभी खुला है",
  "home.test.scheduled": "तय है",
  "home.test.closed": "बंद",
  "home.test.cancelled": "रद्द",
  "home.test.questions": "प्रश्न",
  "home.test.marks": "अंक",
  "home.test.time": "समय",
  "home.test.minutes": { one: "{count} मिनट", other: "{count} मिनट" },
  "home.test.attempts": "कोशिशें",
  "home.test.attemptsOf": "{max} में से {used}",
  "home.test.onPaper":
    "यह टेस्ट कक्षा में काग़ज़ पर होगा। आपके उत्तर शिक्षक दर्ज करेंगे, और परिणाम यहीं दिखेगा।",
  "home.test.seeResult": "नतीजा देखें",
  "home.test.notTaken": "आपने यह टेस्ट नहीं दिया।",
  "home.test.notReleased": "आपके शिक्षक ने अभी नतीजा जारी नहीं किया है।",
  "home.finished.heading": "पूरे हो चुके",

  // -- Home: latest result -------------------------------------------------
  "home.result.heading": "ताज़ा नतीजा",
  "home.result.emptyTitle": "अभी कोई नतीजा नहीं",
  "home.result.emptyBody":
    "जब आपके शिक्षक आपके दिए टेस्ट का नतीजा जारी करेंगे, तो आपके अंक यहाँ दिखेंगे।",
  "home.result.marksLabel": "अंक",
  "home.result.soFar": "अब तक जाँचे गए",
  "home.result.unmarked": "अभी जाँचा नहीं गया",
  "home.result.pending": {
    one: "{count} अंक अभी शिक्षक के पास जाँच के लिए है",
    other: "{count} अंक अभी शिक्षक के पास जाँच के लिए हैं",
  },
  "home.result.toReview": {
    one: "{count} प्रश्न दोबारा देखने लायक है",
    other: "{count} प्रश्न दोबारा देखने लायक हैं",
  },
  "home.result.fullMarks": "हर प्रश्न में पूरे अंक।",
  "home.result.answersLater": "सबके टेस्ट पूरा करने के बाद उत्तर खुलेंगे।",
  "home.result.seeAnswers": "उत्तर देखें",
  "home.result.seeResult": "नतीजा देखें",
  "home.result.thingsToFix": "सुधारने वाले प्रश्न",

  // -- Home: up next -------------------------------------------------------
  "home.plan.heading": "आगे क्या करें",
  "home.plan.whole": {
    one: "पूरी योजना देखें",
    other: "पूरी योजना देखें — {count} काम, क्रम से",
  },

  // -- Home: my concepts ---------------------------------------------------
  "home.concepts.heading": "मेरे कॉन्सेप्ट",
  "home.concepts.secure": "पक्का",
  "home.concepts.almost": "लगभग पक्का",
  "home.concepts.practice": "अभ्यास चाहिए",
  "home.concepts.unknown": "अभी पर्याप्त जानकारी नहीं",
  "home.concepts.startWith": "अब तक सबसे कमज़ोर:",
  "home.concepts.practise": "इसका अभ्यास करें",
  "home.concepts.allSecure": "यहाँ जो भी मापा गया है, सब पक्का है।",
  "home.concepts.noneMeasured": "इस विषय में अभी कुछ मापा नहीं गया।",
  "home.concepts.emptyTitle": "अभी कुछ मापा नहीं गया",
  "home.concepts.emptyBody":
    "कोई टेस्ट दीजिए, फिर यहाँ विषय के हिसाब से दिखेगा कि हर कॉन्सेप्ट में आप कैसा कर रहे हैं।",
  "home.concepts.all": "मेरी प्रगति देखें",

  // -- Home: things to fix -------------------------------------------------
  "home.fix.heading": "सुधारने वाले प्रश्न",
  "home.fix.open": {
    one: "{count} प्रश्न सुधारना है",
    other: "{count} प्रश्न सुधारने हैं",
  },
  "home.fix.resolved": {
    one: "पिछले 7 दिनों में {count} सुधरा",
    other: "पिछले 7 दिनों में {count} सुधरे",
  },
  "home.fix.emptyTitle": "सुधारने को कुछ नहीं",
  "home.fix.emptyBody":
    "टेस्ट में जो प्रश्न गलत होगा, वह यहाँ आएगा, ताकि आप उस पर दोबारा लौट सकें।",
  "home.fix.link": "सूची खोलें",

  // -- Home: teacher feedback ----------------------------------------------
  "home.feedback.heading": "शिक्षक की टिप्पणी",
  "home.feedback.new": "{title} पर नई टिप्पणी",
  "home.feedback.locked":
    "आपके शिक्षक ने टिप्पणी लिखी है। सबके टेस्ट पूरा करने के बाद, जब उत्तर खुलेंगे, तब आप उसे पढ़ सकेंगे।",
  "home.feedback.more": {
    one: "और {count} टेस्ट पर नई टिप्पणी है।",
    other: "और {count} टेस्ट पर नई टिप्पणी है।",
  },
  "home.feedback.read": "पढ़ें",
  "home.feedback.emptyTitle": "कोई नई टिप्पणी नहीं",
  "home.feedback.emptyBody":
    "जब आपके शिक्षक आपके किसी उत्तर पर टिप्पणी लिखेंगे, तो वह यहाँ दिखेगी।",

  // -- Home: announcements -------------------------------------------------
  "home.announcements.heading": "शिक्षकों की सूचनाएँ",
  "home.announcements.truncated": "सबसे नई {count} सूचनाएँ दिखाई गई हैं।",
  "home.announcements.emptyTitle": "कोई सूचना नहीं",
  "home.announcements.emptyBody":
    "पिछले 30 दिनों में आपके शिक्षक ने कक्षा को जो संदेश भेजे हैं, वे यहाँ दिखेंगे।",

  // -- Home: this week's effort --------------------------------------------
  "home.effort.heading": "आपकी मेहनत",
  "home.effort.window": {
    one: "पिछले {count} दिन में",
    other: "पिछले {count} दिनों में",
  },
  "home.effort.sets": "पूरे किए अभ्यास सेट",
  "home.effort.answered": "हल किए अभ्यास प्रश्न",
  "home.effort.fixed": "सुधारी गई गलतियाँ",
  "home.effort.emptyBody":
    "पिछले 7 दिनों में अभी कुछ नहीं। पूरे किए अभ्यास सेट और सुधारे गए प्रश्न यहाँ गिने जाते हैं।",
  "home.effort.start": "अभ्यास शुरू करें",

  // -- Home: saved questions -----------------------------------------------
  "home.saved.heading": "सहेजे गए प्रश्न",
  "home.saved.count": { one: "{count} सहेजा गया", other: "{count} सहेजे गए" },
  "home.saved.all": "सभी सहेजे गए देखें",
  "home.saved.emptyTitle": "कुछ सहेजा नहीं गया",
  "home.saved.emptyBody": "नतीजे में से कोई प्रश्न सहेजें, ताकि बाद में उस पर लौट सकें।",

  // -- Home: exam readiness ------------------------------------------------
  "home.readiness.heading": "परीक्षा की तैयारी",
  "home.readiness.tested": "आपके सभी विषयों के {total} में से {tested} चैप्टर पर टेस्ट हुआ है",
  "home.readiness.open": "पूरी तस्वीर देखें",
  "home.readiness.emptyTitle": "अभी कोई पाठ्यक्रम नहीं",
  "home.readiness.emptyBody":
    "किसी कक्षा में जुड़ने के बाद यहाँ दिखेगा कि आपके टेस्ट ने पाठ्यक्रम का कितना हिस्सा कवर किया है।",

  // -- Home: who can see my progress ---------------------------------------
  "home.viewers.heading": "मेरी प्रगति कौन देख सकता है",
  "home.viewers.none": "आपके शिक्षकों के अलावा कोई और आपकी प्रगति नहीं देख सकता।",
  "home.viewers.active": "आपके अंक और प्रगति देख सकते हैं",
  "home.viewers.invited": "न्योता भेजा गया है। स्वीकार करने तक कुछ नहीं देख सकते।",
  "home.viewers.scope":
    "आपके शिक्षक आपका काम देख सकते हैं। माता-पिता आपके लिखे उत्तर, आपकी सुधारने वाली सूची या आपने जो मदद माँगी, वह कभी नहीं देखते।",
  "relationship.MOTHER": "माँ",
  "relationship.FATHER": "पिता",
  "relationship.GUARDIAN": "अभिभावक",
} satisfies Catalog;
