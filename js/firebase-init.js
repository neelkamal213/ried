// Shared Firebase initialization for the RIED website (plain HTML/CSS/JS site,
// no build step — loaded directly via CDN ES modules, imported by any page that needs auth).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB51HO3PQBUhHIz6EQ_2VMuXB7p_BsR7KQ",
  authDomain: "ried-website.firebaseapp.com",
  projectId: "ried-website",
  storageBucket: "ried-website.firebasestorage.app",
  messagingSenderId: "779120257103",
  appId: "1:779120257103:web:8cafa4d38d2a4247d9a23a"
};

// Pramod and Neel are the only two accounts that should get blog/admin access
// (per the original feature request). Kept here, client-side, purely to decide
// what role to WRITE on signup — actual enforcement happens in Firestore Security
// Rules (see firestore.rules), never trust this list alone for access control.
export const ADMIN_EMAILS = ["pramod@ried.co.in", "neel@ried.co.in"];

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
};
