const conferenceEl = document.querySelector(".conference");
const audioContainer = document.querySelector(".audio-container");
const timer = document.querySelector("#timer");
const form = document.querySelector("form");
const messageContainer = document.querySelector(".message-container");

const socket = io.connect("/"); //make connection with socket server

const state = {
  username: new URLSearchParams(window.location.search).get("username"),
  users: [],
  activeUser: null,
  peers: {}, //store connected users
  stream: null, //store local audio data
  rtcConfig: {
    //simple third party server to retrieve network details
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  },
};

function renderCircle() {
  [...conferenceEl.children].forEach((circle, index) => {
    const user = state.users[index];
    if (user) {
      circle.id = `ID_${user.userId}`;
      circle.style.display = "flex";
      circle.innerHTML = `<label>${user.username} ${index + 1}</label>`;
    } else {
      circle.style.display = "none";
      circle.innerHTML = "";
    }
  });
}

function startTimer() {
  var seconds = 30;
  timer.textContent = seconds;
  return setInterval(() => (timer.textContent = --seconds), 1000);
}

function toggleActiveUser(userId, toggle) {
  const user = conferenceEl.querySelector(`#ID_${userId}`);
  if (!user) return;
  user.classList[toggle ? "add" : "remove"]("active-circle");
}

function chanegMicStatus(message, active) {
  const micEl = document.querySelector(".mic");
  //show message related to micrphone access
  micEl.children[0].textContent = message;
  //change microphone access
  micEl.children[1].innerHTML = `<i class="fas ${
    active ? "fa-microphone" : "fa-microphone-slash"
  }"></i>`;
}

//ask for microphone access
function getAudioStreamAccess() {
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      state.stream = stream;
      //by default disable mic of user
      state.stream.getAudioTracks()[0].enabled = false;
      state.stream.getAudioTracks()[0].addEventListener("mute", () => {
        chanegMicStatus("Your mic is muted", false);
      });
      state.stream.getAudioTracks()[0].addEventListener("unmute", () => {
        chanegMicStatus("Your mic is unmuted", true);
      });
      state.stream.getAudioTracks()[0].addEventListener("ended", (e) => {
        chanegMicStatus("Mic stopped", true);
      });
      socket.emit("user-joined", state.username);
      //chanegMicStatus("Access granted!", true);
      if (state.stream.getAudioTracks()[0].muted) {
        chanegMicStatus("Your mic is muted", false);
      } else {
        chanegMicStatus("You mic is unmuted", true);
      }
    })
    .catch((err) => {
      chanegMicStatus(err.message);
    });
}

function insertMessage(message) {
  const wrapper = document.createElement("div");
  wrapper.classList.add("msg-wrapper");
  if (state.username === message.username) wrapper.classList.add("owner"); //add owner class to align message right side

  const sender = document.createElement("span");
  sender.classList.add("sender");
  sender.innerText = message.username;
  wrapper.appendChild(sender);

  const msg = document.createElement("span");
  msg.classList.add("message");
  msg.innerText = message.text;
  wrapper.appendChild(msg);

  messageContainer.appendChild(wrapper);
  //scroll top to see latest message
  messageContainer.scrollTop = messageContainer.scrollHeight;
}

function setRemoteAudioTrack(event, userId) {
  const [remoteStream] = event.streams;
  const div = document.createElement("div");
  div.id = `DA_${userId}`;
  const audio = document.createElement("audio");
  audio.id = `A_${userId}`;
  audio.srcObject = remoteStream;
  audio.play();
  div.appendChild(audio);
  audioContainer.appendChild(div);
}

function removeRemoteAudioTrack(userId) {
  const child = document.querySelector(`#DA_${userId}`);
  audioContainer.removeChild(child);
}

function assignSpeech(user) {
  //reset previous user circle and audio
  if (state.activeUser) {
    //reset circle color
    toggleActiveUser(state.activeUser?.userId);
  }

  //update active user state with new user
  state.activeUser = user;

  if (!user) return;
  //if current user get a chance to speak
  if (user.username === state.username) {
    //Enable Mic on getting change to speak
    state.stream.getAudioTracks()[0].enabled = true;
    //start timer
    const timer = startTimer();
    //Close speech after 30 seconds
    const interval = setInterval(() => {
      //disable mic after speech timeout
      state.stream.getAudioTracks()[0].enabled = false;
      //stop timer
      clearInterval(timer);
      //update circle color
      toggleActiveUser(user?.userId);
      //stop main timer
      clearInterval(interval);
      //emit complete event to assign next user
      socket.emit("speech-completed");
    }, 30000);
  }
  toggleActiveUser(user?.userId, true);
}

socket.on("room-state", ({ users, activeUser }) => {
  state.users = users;
  renderCircle();
  assignSpeech(activeUser);
});

//start a webrtc call with new user
socket.on("user-joined", async ({ user, isActiveUser }) => {
  //create new connection
  const peerConnection = new RTCPeerConnection(state.rtcConfig);
  //add local track in remote user connection
  const audioTrack = state.stream.getAudioTracks()[0];
  const audioStream = new MediaStream([audioTrack]);
  peerConnection.addTrack(audioTrack, audioStream);
  //create offer for new user
  //offer: contains system config like: type of media format being send, ip address and port of caller
  const offer = await peerConnection.createOffer();
  //set offer description in local connection
  peerConnection.setLocalDescription(offer);
  //receive network details from third party server and send details to new user
  peerConnection.addEventListener("icecandidate", function (event) {
    //send network details to new user
    if (event.candidate) {
      socket.emit("ICE-Candidate", {
        receiver: user.userId,
        candidate: event.candidate,
      });
    }
  });
  //when new user get chance to speak, this listener will trigger and set the remote stream on dom
  peerConnection.addEventListener("track", (event) => {
    setRemoteAudioTrack(event, user.userId);
  });
  //send offer (system config) to new user
  socket.emit("call", { userId: user.userId, offer });
  //store peer connection
  state.peers[user.userId] = { peerConnection };
  state.users.push(user);
  renderCircle();
  if (isActiveUser) assignSpeech(user);
});

//receive answer from new user
socket.on("answer", async ({ responder, answer }) => {
  //get responder connection
  const peerConnection = state.peers[responder].peerConnection;
  //set responder answer (system config) in connection
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
});

//recieve network details (ICE-Candidate) of user
socket.on("ICE-Candidate", async ({ sender, candidate }) => {
  if (!state.peers[sender]) return;
  //find sender peer connection in list of peers
  const peerConnection = state.peers[sender].peerConnection;
  //store network details in connection
  await peerConnection.addIceCandidate(candidate);
});

//receive call (offer) from users and respond to call by sharing their system details
socket.on("call", async ({ caller, offer }) => {
  //create new webrtc peer connection
  const peerConnection = new RTCPeerConnection(state.rtcConfig);
  //add local stream to caller connection
  const audioTrack = state.stream.getAudioTracks()[0];
  const audioStream = new MediaStream([audioTrack]);
  peerConnection.addTrack(audioTrack, audioStream);
  //receive network details from third party server and send it to caller
  peerConnection.addEventListener("icecandidate", function (event) {
    //send network details to caller
    socket.emit("ICE-Candidate", {
      receiver: caller,
      candidate: event.candidate,
    });
  });
  peerConnection.addEventListener("track", (event) => {
    setRemoteAudioTrack(event, caller);
  });
  //set received offer (caller system config) in connection
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  //create your system config as answer
  const answer = await peerConnection.createAnswer();
  //set answer in connection
  await peerConnection.setLocalDescription(answer);
  //send call response (system config) to caller
  socket.emit("answer", { caller, answer });
  //store caller peer connection
  state.peers[caller] = { peerConnection };
});

socket.on("new-speech-assigned", assignSpeech);

socket.on("message", insertMessage);

socket.on("user-disconnect", ({ userId, activeUser }) => {
  //close and delete user connection from list connected users peer
  if (!state.peers[userId]) return;
  state.peers[userId].peerConnection.close();
  delete state.peers[userId];
  //remove user from users array and re render circle
  state.users = state.users.filter((user) => user.userId !== userId);
  renderCircle();
  removeRemoteAudioTrack(userId);
  //activate next active user circle and mic
  assignSpeech(activeUser);
});

//handle form submission
form.addEventListener("submit", (e) => {
  e.preventDefault(); //prevent page from reloading
  const message = e.target.elements.message.value;
  if (!message) return;
  //send message to other users in room
  const payload = {
    username: state.username,
    text: message,
  };
  socket.emit("message", payload);
  //display message in your chat box
  insertMessage(payload);
  //clear form input
  e.target.elements.message.value = "";
  e.target.elements.message.focus();
});

window.addEventListener("DOMContentLoaded", () => getAudioStreamAccess());
