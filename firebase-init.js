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
   changes. Fill these in from your EmailJS dashboard (Account > General for
   the public key; Email Services / Email Templates for the other two) —
   until then EMAILJS_PUBLIC_KEY stays empty and sends are skipped, so the
   rest of the app keeps working normally without it. */
const EMAILJS_SERVICE_ID = '';
const EMAILJS_TEMPLATE_ID = '';
const EMAILJS_PUBLIC_KEY = '';
if (EMAILJS_PUBLIC_KEY && window.emailjs) emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
