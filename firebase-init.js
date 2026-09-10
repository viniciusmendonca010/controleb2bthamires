/* Firebase bootstrap — compat SDK (plain <script> tags, no bundler needed) */
const firebaseConfig = {
  apiKey: "AIzaSyBlwrrmpbvtl-dY-vFZsNzBKefR44rB1DE",
  authDomain: "ceresb2bthamires.firebaseapp.com",
  projectId: "ceresb2bthamires",
  storageBucket: "ceresb2bthamires.firebasestorage.app",
  messagingSenderId: "572758758225",
  appId: "1:572758758225:web:bfd9114b8a9904e3923970"
};

firebase.initializeApp(firebaseConfig);

const fbAuth = firebase.auth();
const fbDb = firebase.firestore();
const fbStorage = firebase.storage();

/* EmailJS — notifies the partner's registered e-mail when a request's status
   changes. Sends via vinicius.mnviana@gmail.com (connected as the Gmail
   service below); the notification e-mails will show that as the sender. */
const EMAILJS_SERVICE_ID = 'service_8f7hu3a';
const EMAILJS_TEMPLATE_ID = 'template_6ectby2';
const EMAILJS_PUBLIC_KEY = 'juXOEcvc7GWLx-nS5';
if (EMAILJS_PUBLIC_KEY && window.emailjs) emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
