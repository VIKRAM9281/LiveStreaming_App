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
// const socket = io('https://streamalong.live');
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
  const [SocketIs,setSocketIs]=useState(socket.connected)
  const peersRef = useRef({});
   const [peerConnection, setPeerConnection] = useState(null);
useEffect(() => {
    const setupConnection = async () => {
      try {
        const response = await fetch('https://saluslivestream.metered.live/api/v1/turn/credentials?apiKey=55b40b68db82fa6d95da9a535f2371abbee1');

        if (!response.ok) {
          throw new Error('Failed to fetch ICE servers');
        }
        const data = await response.json();
        const pcConfig = {
          iceServers: data
        };
        setPeerConnection(pcConfig); // <-- Create a new state variable
        console.log('RTCPeerConnection initialized with:', data);
      } catch (error) {
        console.error('Error setting up peer connection:', error);
      }
    };

    setupConnection();
  }, []);
  useEffect(() => {
       const handleConnect = () => setSocketIs(true);
        const handleDisconnect = () => setSocketIs(false);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
if (socket.connected) {
    setSocketIs(true)
  console.log('🔵 Socket is currently connected');
} else {
    setSocketIs(false)
  console.log('🔴 Socket is currently disconnected');
}
    socket.on('room-created', () => {
      console.log('🛠 Room created');
      setJoined(true);
      setIsHost(true);
      setLoading(false);
    });

    socket.on('room-joined', ({ isHostStreaming }) => {
      console.log('👋 Room joined, host streaming:', isHostStreaming);
      setJoined(true);
      setIsHost(false);
      setIsHostStreaming(isHostStreaming);
      setLoading(false);
    });

    socket.on('host-started-streaming', () => {
      console.log('📺 Host has started streaming');
      setIsHostStreaming(true);
    });

    socket.on('room-full', () => {
      setLoading(false);
      setError('Room is full');
    });

    socket.on('invalid-room', () => {
      setLoading(false);
      setError('Room does not exist');
    });

    socket.on('room-exists', () => {
      setLoading(false);
      setError('Room already exists');
    });

    socket.on('host-left', () => {
      console.log('🛑 Host ended the stream');
      setIsHostStreaming(false);
    });

    socket.on('room-closed', endStream);

    socket.on('user-joined', handleUserJoined);

socket.on('viewer-joined', (hostId) => {
  console.log(`👀 Viewer joined, preparing to connect to host ${hostId}`);
  const pc = createPeerConnection(hostId);
  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => {
      socket.emit('offer', { target: hostId, sdp: pc.localDescription });
    })
    .catch((err) => {
      console.error('❌ Error during offer creation:', err);
    });
});

    socket.on('offer', handleReceiveOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleNewICECandidate);
    socket.on('user-left', handleUserLeft);

    return () => {
      socket.off('connect');
      socket.off('room-created');
      socket.off('room-joined');
      socket.off('host-started-streaming');
      socket.off('room-full');
      socket.off('invalid-room');
      socket.off('room-exists');
      socket.off('host-left');
      socket.off('room-closed');
      socket.off('user-joined');
      socket.off('viewer-joined');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('user-left');
      endStream();
    };
  }, [SocketIs]);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ]);
        return (
          granted['android.permission.CAMERA'] === PermissionsAndroid.RESULTS.GRANTED &&
          granted['android.permission.RECORD_AUDIO'] === PermissionsAndroid.RESULTS.GRANTED
        );
      } catch (err) {
        console.warn('Permission error:', err);
        return false;
      }
    }
    return true;
  };

  const createOrJoinRoom = async (type) => {
    if (!roomId.trim()) {
      setError('Please enter a room ID');
      return;
    }

    setError('');
    setLoading(true);

    const permissionsGranted = await requestPermissions();
    if (!permissionsGranted) {
      setLoading(false);
      setError('Camera and microphone permissions are required');
      return;
    }

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

      setLocalStream(stream);
      setIsStreaming(true);
      setLoading(false);

      socket.emit('host-streaming', roomId);

      Object.keys(peersRef.current).forEach(async (id) => {
        const pc = peersRef.current[id];
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: id, sdp: pc.localDescription });
      });
    } catch (error) {
      console.error('❌ Error getting stream:', error);
      setLoading(false);
      setError('Failed to start stream');
    }
  };

  const switchCamera = async () => {
    try {
      setLoading(true);
      setIsFrontCamera((prev) => !prev);

      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }

      const newStream = await mediaDevices.getUserMedia({
        video: { facingMode: !isFrontCamera ? 'user' : 'environment' },
        audio: true,
      });

      setLocalStream(newStream);
      setLoading(false);

      Object.values(peersRef.current).forEach((pc) => {
        pc.getSenders().forEach((sender) => {
          const kind = sender.track?.kind;
          const newTrack = newStream.getTracks().find((t) => t.kind === kind);
          if (newTrack) {
            sender.replaceTrack(newTrack);
          }
        });
      });
    } catch (error) {
      console.error('Error switching camera:', error);
      setLoading(false);
      setError('Failed to switch camera');
    }
  };

  const endStream = () => {
    try {
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        setLocalStream(null);
      }

      Object.values(peersRef.current).forEach((pc) => pc.close());

      setIsStreaming(false);
      setIsHostStreaming(false);
      setJoined(false);
      setIsHost(false);
      setRemoteStreams({});
      peersRef.current = {};

      socket.emit('leave-room', roomId);
    } catch (error) {
      console.error('Error ending stream:', error);
    }
  };

  const createPeerConnection = (id) => {
    console.log(`🔗 Creating peer connection for ${id}`);
    const randomStr = Math.random().toString(36).substring(2, 6);
   const pc = new RTCPeerConnection(peerConnection);
    pc.oniceconnectionstatechange = () => {
      console.log('ICE State:', pc.iceConnectionState);
    };
pc.onicegatheringstatechange = () => {
  console.log("🧊 ICE gathering state:", pc.iceGatheringState);
};
pc.onicecandidate = (event) => {
  if (event.candidate) {
    console.log(`📡 Sending ICE candidate to ${id}:`, event.candidate);
    socket.emit('ice-candidate', {
      target: id,
      candidate: event.candidate,
    });
  } else {
    console.log('🚫 ICE candidate is null (gathering complete)');
  }
};


    pc.ontrack = (event) => {
      console.log(`📺 Received track from ${id}`);
      setRemoteStreams((prev) => ({
        ...prev,
        [id]: event.streams[0],
      }));
    };

    pc.onconnectionstatechange = () => {
      console.log(`🔌 Connection state for ${id}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        handleUserLeft(id);
      }
    };

    peersRef.current[id] = pc;
    return pc;
  };

  const handleUserJoined = async (id) => {
    if (isHost) {
      console.log(`👋 Viewer ${id} joined, creating offer`);
      const pc = createPeerConnection(id);
      if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { target: id, sdp: pc.localDescription });
    }
  };

  const handleReceiveOffer = async ({ sdp, sender }) => {
    console.log(`📩 Received offer from ${sender}`);
    let pc = peersRef.current[sender];
    if (!pc) {
      pc = createPeerConnection(sender);
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(`📤 Sending answer to ${sender}`);
      socket.emit('answer', { target: sender, sdp: pc.localDescription });
    } catch (error) {
      console.error('❌ Error handling offer:', error);
    }
  };

  const handleAnswer = async ({ sdp, sender }) => {
    console.log(`📩 Received answer from ${sender}`);
    const pc = peersRef.current[sender];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (error) {
        console.error('❌ Error handling answer:', error);
      }
    }
  };

  const handleNewICECandidate = async ({ candidate, sender }) => {
    console.log(`📡 Received ICE candidate from ${sender}`);
    const pc = peersRef.current[sender];
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('❌ Error handling ICE candidate:', error);
      }
    }
  };

  const handleUserLeft = (id) => {
    console.log(`🚪 User ${id} left`);
    if (peersRef.current[id]) {
      peersRef.current[id].close();
      delete peersRef.current[id];
    }
    setRemoteStreams((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
  };

  const renderJoinScreen = () => (
  SocketIs  ? (
    <>
      <TextInput
        style={styles.input}
        placeholder="Enter Room ID"
        value={roomId}
        onChangeText={(text) => {
          setRoomId(text);
          setError('');
        }}
        placeholderTextColor="#999"
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.createButton]}
          onPress={() => createOrJoinRoom('create')}
          disabled={loading}
        >
          {loading && isHost ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Create Room</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.joinButton]}
          onPress={() => createOrJoinRoom('join')}
          disabled={loading}
        >
          {loading && !isHost ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Join Room</Text>
          )}
        </TouchableOpacity>
      </View>
    </>
  ) : (
    <View>
      <Text style={[styles.input, { color: 'red', textAlign: 'center' }]}>
        🚫 Socket is disconnected. Please check your Socket connection And Internet connection.
      </Text>
    </View>
  )
  );

  const renderHostControls = () => (
    <View>
      <Button
        title="Start Streaming"
        onPress={startStream}
        disabled={loading || isStreaming}
      />
      {loading && <ActivityIndicator style={styles.loadingIndicator} />}
    </View>
  );

  const renderViewerScreen = () => (
    <View style={styles.viewerContainer}>
      {isHostStreaming ? (
        Object.entries(remoteStreams).length > 0 ? (
          <RTCView
            streamURL={Object.values(remoteStreams)[0].toURL()}
            style={styles.fullScreenVideo}
            objectFit="cover"
          />
        ) : (
          <View style={styles.waitingContainer}>
            <ActivityIndicator size="large" />
            <Text style={styles.waitingText}>Connecting to host stream...</Text>
          </View>
        )
      ) : (
        <View style={styles.waitingContainer}>
          <ActivityIndicator size="large" />
          <Text style={styles.waitingText}>Waiting for host to start streaming...</Text>
        </View>
      )}
      <Button title="Leave Room" color="red" onPress={endStream} />
    </View>
  );

  const renderStreamingScreen = () => (
    <>
      <RTCView
        streamURL={localStream?.toURL()}
        style={styles.fullScreenVideo}
        objectFit="cover"
        mirror={isFrontCamera}
      />
      <View style={styles.bottomOverlay}>
        <Text style={styles.userCountText}>
          👥 {Object.keys(peersRef.current).length} viewer(s)
        </Text>
        <Button title="Switch Camera" onPress={switchCamera} disabled={loading} />
        <View style={{ height: 10 }} />
        <Button title="End Streaming" color="red" onPress={endStream} />
      </View>
    </>
  );

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>🎥 Live Stream App</Text>
      {!joined && renderJoinScreen()}
      {joined && !isStreaming && isHost && renderHostControls()}
      {joined && !isHost && renderViewerScreen()}
      {isStreaming && renderStreamingScreen()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    paddingHorizontal: 15,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginVertical: 15,
    color: '#fff',
    textAlign: 'center',
  },
  input: {
    borderColor: '#444',
    borderWidth: 1,
    backgroundColor: '#222',
    marginVertical: 15,
    paddingHorizontal: 15,
    height: 50,
    borderRadius: 8,
    color: '#fff',
    fontSize: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  button: {
    flex: 1,
    padding: 15,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 5,
  },
  createButton: {
    backgroundColor: '#4CAF50',
  },
  joinButton: {
    backgroundColor: '#2196F3',
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  fullScreenVideo: {
    flex: 1,
    width: '100%',
    backgroundColor: 'black',
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 20,
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  userCountText: {
    color: '#fff',
    fontSize: 16,
    marginBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 8,
    borderRadius: 20,
  },
  errorText: {
    color: '#ff4444',
    textAlign: 'center',
    marginBottom: 15,
  },
  loadingIndicator: {
    marginVertical: 15,
  },
  viewerContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  waitingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  waitingText: {
    color: '#fff',
    fontSize: 16,
    marginVertical: 20,
    textAlign: 'center',
  },
});