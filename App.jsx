import React, { useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import {
  mediaDevices,
  RTCView,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'react-native-webrtc';
import io from 'socket.io-client';

const socket = io('https://streamingbackend-eh65.onrender.com');

export default function App() {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isHostStreaming, setIsHostStreaming] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isHost, setIsHost] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [socketIsConnected, setSocketIsConnected] = useState(socket.connected);

  const peersRef = useRef({});
  const [iceConfig, setIceConfig] = useState({
    iceServers: [
      {
        "urls": "turn:coturn.streamalong.live:3478?transport=udp",
        "username": "vikram",
        "credential": "vikram"
      }
    ]
  });

  useEffect(() => {
    const fetchICE = async () => {
      try {
        const res = await fetch(
          'https://saluslivestream.metered.live/api/v1/turn/credentials?apiKey=55b40b68db82fa6d95da9a535f2371abbee1'
        );
        const data = await res.json();
        // Optionally: setIceConfig({ iceServers: data });
      } catch (err) {
        console.warn('Failed to fetch TURN servers. Using fallback.');
      }
    };
    fetchICE();
  }, []);
useEffect(() => {
  const setupStream = async () => {
    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    setLocalStream(stream);
  };
  setupStream();
}, []);

  useEffect(() => {
    socket.on('connect', () => setSocketIsConnected(true));
    socket.on('disconnect', () => setSocketIsConnected(false));

    socket.on('room-created', () => {
      setJoined(true);
      setIsHost(true);
      setLoading(false);
    });

    socket.on('room-joined', ({ isHostStreaming }) => {
        console.log(`room joined`)
      setJoined(true);
      setIsHost(false);
      setIsHostStreaming(isHostStreaming);
      setLoading(false);
    });

    socket.on('room-full', () => {
      setLoading(false);
      setError('Room is full');
    });

    socket.on('invalid-room', () => {
      setLoading(false);
      setError('Invalid room ID');
    });

    socket.on('room-exists', () => {
      setLoading(false);
      setError('Room already exists');
    });

    socket.on('host-started-streaming', () => setIsHostStreaming(true));
    socket.on('host-left', () => setIsHostStreaming(false));
    socket.on('room-closed', endStream);
    socket.on('user-left', handleUserLeft);
    socket.on('user-joined', handleUserJoined);
    socket.on('viewer-joined', handleViewerJoined);
    socket.on('offer', handleReceiveOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleNewICECandidate);

    return () => {
      socket.removeAllListeners();
    };
  }, [localStream, iceConfig]);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      return (
        granted['android.permission.CAMERA'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.RECORD_AUDIO'] === PermissionsAndroid.RESULTS.GRANTED
      );
    }
    return true;
  };

  const createOrJoinRoom = async (type) => {
    if (!roomId.trim()) return setError('Enter a valid room ID');

    setLoading(true);
    const permissions = await requestPermissions();
    if (!permissions) {
      setError('Permissions denied');
      setLoading(false);
      return;
    }

    setError('');
    if (type === 'create') {
      socket.emit('create-room', roomId);
    } else {
      socket.emit('join-room', roomId);
    }
  };

const startStream = async () => {
  try {
    setLoading(true);
    const stream = await mediaDevices.getUserMedia({
      video: { facingMode: isFrontCamera ? 'user' : 'environment' },
      audio: true,
    });

    if (!stream) throw new Error('Failed to get media stream');

    setLocalStream(stream);
    setIsStreaming(true);
    socket.emit('host-streaming', roomId);

    for (const id of Object.keys(peersRef.current)) {
      const pc = peersRef.current[id];
      if (!pc) continue;
    console.log(stream)
    console.log(stream.getTracks())
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { target: id, sdp: pc.localDescription });
    }
  } catch (err) {
    console.error('startStream error:', err);
    setError('Failed to start stream');
  } finally {
    setLoading(false);
  }
};


const createPeerConnection = async (id) => {
  if (peersRef.current[id]) {
    return peersRef.current[id];
  }

  const pc = new RTCPeerConnection(iceConfig);
console.log(pc.onicecandidate)
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { target: id, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    setRemoteStreams((prev) => ({
      ...prev,
      [id]: event.streams[0],
    }));
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      handleUserLeft(id);
    }
  };

  peersRef.current[id] = pc;
console.log(pc)
console.log(peersRef.current[id])

  return pc;
};



const handleUserJoined = async (id) => {
  if (!isHost) return;

  try {
      console.log(localStream)
    if (!localStream) {
      console.warn('Local stream not ready, delaying offer creation...');
      setTimeout(() => handleUserJoined(id), 1000);
      return;
    }

    const pc = await createPeerConnection(id);
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
console.log(offer)
console.log(pc.localDescription)
    socket.emit('offer', { target: id, sdp: pc.localDescription });
  } catch (error) {
    console.error('Error in handleUserJoined:', error);
  }
};






const handleViewerJoined = async (hostId) => {
  const pc = await createPeerConnection(hostId);

  if (!pc) return console.warn('Peer connection failed');

  // Don't getUserMedia here — viewer doesn't need to send video/audio
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  console.log(offer)
  console.log(pc.localDescription)
  socket.emit('offer', { target: hostId, sdp: pc.localDescription });
};


const handleReceiveOffer = async ({ sdp, sender }) => {
  const pc = await createPeerConnection(sender);
  if (!pc) return;
console.log(sdp)
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  console.log(pc.localDescription)
  socket.emit('answer', { target: sender, sdp: pc.localDescription });
};


  const handleAnswer = async ({ sdp, sender }) => {
    const pc = peersRef.current[sender];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  };

  const handleNewICECandidate = async ({ candidate, sender }) => {
    const pc = peersRef.current[sender];
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  };

  const handleUserLeft = (id) => {
    const pc = peersRef.current[id];
    if (pc) {
      pc.close();
      delete peersRef.current[id];
    }
    setRemoteStreams((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
  };

  const endStream = () => {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }
    Object.values(peersRef.current).forEach((pc) => pc.close());
    peersRef.current = {};
    setIsStreaming(false);
    setJoined(false);
    setIsHost(false);
    setRemoteStreams({});
    socket.emit('leave-room', roomId);
  };

  const switchCamera = async () => {
    setIsFrontCamera((prev) => !prev);
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    const newStream = await mediaDevices.getUserMedia({
      video: { facingMode: isFrontCamera ? 'environment' : 'user' },
      audio: true,
    });
    setLocalStream(newStream);

    Object.values(peersRef.current).forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        const kind = sender.track?.kind;
        const newTrack = newStream.getTracks().find((t) => t.kind === kind);
        if (newTrack) sender.replaceTrack(newTrack);
      });
    });
  };

  const renderJoinScreen = () => (
    socketIsConnected ? (
      <>
        <TextInput
          style={styles.input}
          placeholder="Enter Room ID"
          value={roomId}
          onChangeText={setRoomId}
          placeholderTextColor="#999"
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        <View style={styles.buttonRow}>
          <TouchableOpacity style={[styles.button, styles.createButton]} onPress={() => createOrJoinRoom('create')}>
            <Text style={styles.buttonText}>Create Room</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.joinButton]} onPress={() => createOrJoinRoom('join')}>
            <Text style={styles.buttonText}>Join Room</Text>
          </TouchableOpacity>
        </View>
      </>
    ) : (
      <Text style={[styles.input, { color: 'red', textAlign: 'center' }]}>
        🚫 Socket is disconnected.
      </Text>
    )
  );
console.log(remoteStreams)
console.log(localStream)
  const renderStreamingScreen = () => (
    <>
      {localStream && typeof localStream.toURL === 'function' && (
        <RTCView
          streamURL={localStream.toURL()}
          style={styles.fullScreenVideo}
          objectFit="cover"
          mirror={isFrontCamera}
        />
      )}
      <View style={styles.bottomOverlay}>
        <Button title="Switch Camera" onPress={switchCamera} />
        <Button title="End Stream" color="red" onPress={endStream} />
      </View>
    </>
  );

const renderViewerScreen = () => {
  const remoteStream = Object.values(remoteStreams)[0];

  const isStreamAvailable =
    remoteStream &&
    typeof remoteStream.toURL === 'function';

  return (
    <>
      {isHostStreaming && isStreamAvailable ? (
        <RTCView
          streamURL={remoteStream.toURL()}
          style={styles.fullScreenVideo}
        />
      ) : (
        <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <ActivityIndicator size="large" />
          <Text style={{ color: 'white', marginTop: 10 }}>
            Waiting for host to start streaming...
          </Text>
        </View>
      )}
      <Button title="Leave Room" color="red" onPress={endStream} />
    </>
  );
};


  const renderHostControls = () => (
    <Button title="Start Streaming" onPress={startStream} disabled={loading || isStreaming} />
  );

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>🎥 Live Stream App</Text>
      {!joined && renderJoinScreen()}
      {joined && isHost && !isStreaming && renderHostControls()}
      {joined && !isHost && renderViewerScreen()}
      {isStreaming && renderStreamingScreen()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 15 },
  title: { color: '#fff', textAlign: 'center', fontSize: 20, margin: 10 },
  input: { backgroundColor: '#222', color: '#fff', padding: 10, borderRadius: 8, marginVertical: 10 },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-between' },
  button: { padding: 15, borderRadius: 8, marginHorizontal: 5 },
  createButton: { backgroundColor: '#4CAF50' },
  joinButton: { backgroundColor: '#2196F3' },
  buttonText: { color: '#fff', fontWeight: 'bold' },
  fullScreenVideo: { flex: 1, width: '100%', backgroundColor: '#000' },
  bottomOverlay: { padding: 10, backgroundColor: '#111' },
  errorText: { color: 'red' },
});
