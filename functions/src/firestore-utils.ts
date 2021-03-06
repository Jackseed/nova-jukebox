import admin = require('firebase-admin');

//--------------------------------
//   Saves tracks to Firestore  //
//--------------------------------
// Saves tracks to Firestore 'tracks' collection.
export async function saveTracks(req: any, res: any) {
  const tracks = req.body.tracks;
  const firebaseWriteLimit = 500;
  console.log('total tracks saving: ', tracks.length);
  for (let i = 0; i <= Math.floor(tracks.length / firebaseWriteLimit); i++) {
    const bactchTracks = tracks.slice(
      firebaseWriteLimit * i,
      firebaseWriteLimit * (i + 1)
    );
    const batch = admin.firestore().batch();
    for (const track of bactchTracks) {
      if (track) {
        const ref = admin.firestore().collection('tracks').doc();
        batch.set(ref, track, { merge: true });
      }
    }

    await batch
      .commit()
      .then((_: any) => console.log(`batch of ${i} saved`))
      .catch((error: any) => console.log(error.response.data));
  }
  res.json({
    result: `Tracks successfully saved on Firestore, total tracks: ${tracks.length}.`,
  });

  return res;
}

//--------------------------------
//   Saves token to Firestore  //
//--------------------------------
// Saves Spotify access or refresh token to Firestore 'user' document.
export async function saveToken(req: any, res: any) {
  const accessToken = req.body.token;
  if (accessToken) {
    let tokens: { access: string; addedTime: Object; refresh?: string } = {
      access: accessToken,
      addedTime: admin.firestore.FieldValue.serverTimestamp(),
    };
    // Adds refresh token only when requesting an access token for the first time.
    if (req.body.tokenType === 'access')
      tokens = { ...tokens, refresh: req.body.refreshToken };

    await admin.firestore().collection('users').doc(req.body.userId).set(
      {
        tokens,
      },
      { merge: true }
    );

    res.json({ result: `Access token successfully added: ${accessToken}.` });
  } else {
    res.json({ result: `Empty token.` });
  }
}

//--------------------------------
//   CREATES FIREBASE ACCOUNT   //
//--------------------------------
export async function createFirebaseAccount(
  uid: string,
  displayName: string,
  email: string
): Promise<string> {
  const dbTask = admin.firestore().collection('users').doc(uid).set(
    {
      uid,
      displayName,
      email,
      emailVerified: true,
    },
    { merge: true }
  );
  // Creates or update the user account.
  const authTask = admin
    .auth()
    .updateUser(uid, {
      displayName,
      email,
      emailVerified: true,
    })
    .catch((error) => {
      // If user does not exists we create it.
      if (error.code === 'auth/user-not-found') {
        return admin.auth().createUser({
          uid,
          displayName,
          email,
          emailVerified: true,
        });
      }
      throw error;
    });
  // Waits for all async tasks to complete, then generate and return a custom auth token.
  await Promise.all([dbTask, authTask]);

  // Creates a Firebase custom auth token.
  const custom_auth_token = await admin.auth().createCustomToken(uid);

  return custom_auth_token;
}
