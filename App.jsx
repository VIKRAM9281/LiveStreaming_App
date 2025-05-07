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

// Initialize Socket.IO client
const socket = io('https://streamingbackend-eh65.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

// Default ICE configuration
const defaultIceConfig = {
  iceServers: [
    {
      urls: 'turn:coturn.streamalong.live:3478?transport=udp',
      username: 'vikram',
      credential: 'vikram',
    },
  ],
};

export default function App() {
  // State for UI and streaming
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

  // Refs for persistent state
  const peersRef = useRef({});
  const pendingViewersRef = useRef([]);
  const iceCandidateBuffer = useRef({});
  const isHostRef = useRef(false);
  const streamStateRef = useRef({ localStream: null, isStreaming: false });
  const processedViewersRef = useRef(new Set()); // Track processed viewer IDs

  // 1. INITIALIZATION
  useEffect(() => {
    const setupSocketListeners = () => {
      socket.on('connect', () => {
        console.log('Socket connected');
        setSocketIsConnected(true);
        if (roomId && joined) {
          socket.emit(isHostRef.current ? 'create-room' : 'join-room', roomId);
        }
      });
      socket.on('reconnect', () => {
        console.log('Socket reconnected');
        setSocketIsConnected(true);
        if (roomId && joined) {
          socket.emit(isHostRef.current ? 'create-room' : 'join-room', roomId);
        }
      });
      socket.on('disconnect', () => {
        console.log('Socket disconnected');
        setSocketIsConnected(false);
      });
      socket.on('room-created', () => {
        console.log('Room created');
        setJoined(true);
        setIsHost(true);
        isHostRef.current = true;
        setLoading(false);
      });
      socket.on('room-joined', ({ isHostStreaming }) => {
        console.log('Room joined, host streaming:', isHostStreaming);
        setJoined(true);
        setIsHost(false);
        isHostRef.current = false;
        setIsHostStreaming(isHostStreaming);
        setLoading(false);
      });
      socket.on('room-full', () => {
        setError('Room is full');
        setLoading(false);
      });
      socket.on('invalid-room', () => {
        setError('Invalid room ID');
        setLoading(false);
      });
      socket.on('room-exists', () => {
        setError('Room already exists');
        setLoading(false);
      });
      socket.on('host-started-streaming', () => setIsHostStreaming(true));
      socket.on('host-left', () => {
        setIsHostStreaming(false);
        setJoined(false);
      });
      socket.on('room-closed', endStream);
      socket.on('user-joined', (id) => handleUserJoined(id));
      socket.on('viewer-joined', (hostId) => handleViewerJoined(hostId));
      socket.on('user-left', (id) => handleUserLeft(id));
      socket.on('offer', ({ sdp, sender }) => handleReceiveOffer(sdp, sender));
      socket.on('answer', ({ sdp, sender }) => handleAnswer(sdp, sender));
      socket.on('ice-candidate', ({ candidate, sender }) => handleNewICECandidate(candidate, sender));
      socket.on('error', ({ error }) => setError(error));
    };
    setupSocketListeners();

    return () => {
      console.log('Cleaning up socket listeners');
      socket.removeAllListeners();
    };
  }, []);

  // 2. PERMISSIONS AND STREAM SETUP (HOST)
  useEffect(() => {
    if (!isHost) return;

    const setupStream = async () => {
      try {
        const hasPermissions = await requestPermissions();
        if (!hasPermissions) throw new Error('Permissions denied');
        const stream = await mediaDevices.getUserMedia({
          audio: true,
          video: { facingMode: 'user', width: 320, height: 240, frameRate: 15 },
        });
        setLocalStream(stream);
        streamStateRef.current.localStream = stream;
        console.log('Local stream setup:', stream);
      } catch (err) {
        console.error('Stream setup failed:', err);
        setError('Failed to access camera or microphone');
      }
    };
    setupStream();

    return () => {
      if (streamStateRef.current.localStream) {
        streamStateRef.current.localStream.getTracks().forEach((track) => track.stop());
      }
      Object.values(peersRef.current).forEach((pc) => pc.close());
      peersRef.current = {};
    };
  }, [isHost]);

  useEffect(() => {
    streamStateRef.current.localStream = localStream;
    streamStateRef.current.isStreaming = isStreaming;
    if (isHost && localStream && isStreaming && pendingViewersRef.current.length > 0) {
      const viewers = [...pendingViewersRef.current];
      pendingViewersRef.current = [];
      viewers.forEach((id) => {
        if (!processedViewersRef.current.has(id)) {
          handleUserJoined(id);
        }
      });
    }
  }, [localStream, isStreaming, isHost]);

  const requestPermissions = async () => {
    if (Platform.OS !== 'android') return true;
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
      setError('Failed to request permissions');
      return false;
    }
  };

  // 3. ROOM MANAGEMENT
  const createOrJoinRoom = async (type) => {
    if (!roomId.trim()) {
      setError('Enter a valid room ID');
      return;
    }
    if (!socketIsConnected) {
      setError('Socket is not connected, please wait');
      return;
    }
    setLoading(true);
    setError('');
    socket.emit(type === 'create' ? 'create-room' : 'join-room', roomId);
  };

  // 4. WEBRTC SIGNALING
  const createPeerConnection = (id) => {
    const pc = new RTCPeerConnection({ ...defaultIceConfig, sdpSemantics: 'unified-plan' });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { target: id, candidate });
    };
    pc.onicecandidateerror = (event) => setError(`ICE error for ${id}: ${event.errorText}`);
    pc.ontrack = ({ streams }) => {
      setRemoteStreams((prev) => ({ ...prev, [id]: streams[0] }));
    };
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        handleUserLeft(id);
      }
    };
    peersRef.current[id] = pc;
    iceCandidateBuffer.current[id] = iceCandidateBuffer.current[id] || [];
    return pc;
  };

  const handleUserJoined = async (id) => {
    // Validate viewer ID
    if (!id || typeof id !== 'string') {
      console.warn('Invalid viewer ID:', id);
      setError('Invalid viewer ID received');
      return;
    }

    // Check if already processed
    if (processedViewersRef.current.has(id)) {
      console.log(`Viewer ${id} already processed`);
      return;
    }

    if (!isHostRef.current || !streamStateRef.current.localStream || !streamStateRef.current.isStreaming) {
      console.log(`Queuing viewer ${id}: Host not ready`);
      pendingViewersRef.current = [...pendingViewersRef.current, id];
      return;
    }

    try {
      // Mark viewer as processed
      processedViewersRef.current.add(id);

      // Step 1: Create peer connection
      let pc = peersRef.current[id] || createPeerConnection(id);
      if (!pc || pc.signalingState === 'closed') {
        console.log(`Recreating peer connection for ${id}`);
        pc = createPeerConnection(id);
      }

      // Step 2: Add tracks
      const tracks = streamStateRef.current.localStream.getTracks().filter(
        (track) => track.enabled && track.readyState === 'live' && ['audio', 'video'].includes(track.kind)
      );
      if (!tracks.length) {
        throw new Error('No valid tracks available');
      }
      tracks.forEach((track) => {
        console.log(`Adding track ${track.kind} for ${id}`);
        pc.addTrack(track, streamStateRef.current.localStream);
      });

      // Step 3: Create offer
      const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      console.log(`Offer created for ${id}`);

      // Step 4: Set local description and emit offer
      if (pc.signalingState !== 'closed') {
        await pc.setLocalDescription(offer);
        console.log(`Local description set for ${id}`);
        socket.emit('offer', { target: id, sdp: pc.localDescription });
      } else {
        throw new Error('Peer connection closed before setting local description');
      }
    } catch (err) {
      console.error(`Error handling user ${id}:`, err.message, err.stack);
      setError(`Failed to connect to viewer ${id}: ${err.message}`);
      // Remove from processed viewers to allow retry
      processedViewersRef.current.delete(id);
      pendingViewersRef.current = [...pendingViewersRef.current, id];
    }
  };

  const handleViewerJoined = (hostId) => {
    if (isHostRef.current) return;
    createPeerConnection(hostId);
  };

  const handleReceiveOffer = async (sdp, sender) => {
    try {
      const pc = peersRef.current[sender] || createPeerConnection(sender);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      if (iceCandidateBuffer.current[sender]?.length) {
        for (const candidate of iceCandidateBuffer.current[sender]) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        iceCandidateBuffer.current[sender] = [];
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { target: sender, sdp: pc.localDescription });
    } catch (err) {
      console.error('Error processing offer:', err);
      setError('Failed to process offer');
    }
  };

  const handleAnswer = async (sdp, sender) => {
    const pc = peersRef.current[sender];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error('Error processing answer:', err);
        setError('Failed to process answer');
      }
    }
  };

  const handleNewICECandidate = async (candidate, sender) => {
    const pc = peersRef.current[sender];
    if (pc) {
      try {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          iceCandidateBuffer.current[sender] = iceCandidateBuffer.current[sender] || [];
          iceCandidateBuffer.current[sender].push(candidate);
        }
      } catch (err) {
        console.error('Error processing ICE candidate:', err);
        setError('Failed to process ICE candidate');
      }
    }
  };

  const handleUserLeft = (id) => {
    const pc = peersRef.current[id];
    if (pc) pc.close();
    delete peersRef.current[id];
    setRemoteStreams((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
    pendingViewersRef.current = pendingViewersRef.current.filter((viewerId) => viewerId !== id);
    processedViewersRef.current.delete(id);
    delete iceCandidateBuffer.current[id];
  };

  // 5. STREAM CONTROL
  const startStream = async () => {
    setLoading(true);
    try {
      // Step 1: Ensure localStream
      if (!streamStateRef.current.localStream) {
        const stream = await mediaDevices.getUserMedia({
          video: { facingMode: isFrontCamera ? 'user' : 'environment', width: 320, height: 240, frameRate: 15 },
          audio: true,
        });
        setLocalStream(stream);
        streamStateRef.current.localStream = stream;
        console.log('Local stream ensured:', stream);
      }

      // Step 2: Emit host-streaming
      setIsStreaming(true);
      streamStateRef.current.isStreaming = true;
      socket.emit('host-streaming', roomId);
      console.log('Emitted host-streaming for room:', roomId);

      // Step 3: For each viewer, call handleUserJoined
      const viewerIds = Object.keys(peersRef.current);
      console.log('Processing viewers:', viewerIds);
      if (viewerIds.length > 0) {
        for (const id of viewerIds) {
          if (peersRef.current[id].connectionState !== 'closed' && !processedViewersRef.current.has(id)) {
            await handleUserJoined(id);
          }
        }
      } else {
        console.log('No viewers to process');
      }
    } catch (err) {
      console.error('Error starting stream:', err);
      setError('Failed to start stream');
    } finally {
      setLoading(false);
    }
  };

  const endStream = () => {
    if (streamStateRef.current.localStream) {
      streamStateRef.current.localStream.getTracks().forEach((track) => track.stop());
    }
    Object.values(peersRef.current).forEach((pc) => pc.close());
    peersRef.current = {};
    pendingViewersRef.current = [];
    iceCandidateBuffer.current = {};
    processedViewersRef.current.clear();
    setIsStreaming(false);
    setJoined(false);
    setIsHost(false);
    isHostRef.current = false;
    setLocalStream(null);
    streamStateRef.current = { localStream: null, isStreaming: false };
    setRemoteStreams({});
    socket.emit('leave-room', roomId);
  };

  const switchCamera = async () => {
    setIsFrontCamera((prev) => !prev);
    try {
      const newStream = await mediaDevices.getUserMedia({
        video: { facingMode: isFrontCamera ? 'environment' : 'user', width: 320, height: 240, frameRate: 15 },
        audio: false,
      });
      const newVideoTrack = newStream.getVideoTracks()[0];
      Object.values(peersRef.current).forEach((pc) => {
        const videoSender = pc.getSenders().find((sender) => sender.track?.kind === 'video');
        if (videoSender) videoSender.replaceTrack(newVideoTrack);
      });
      if (streamStateRef.current.localStream) {
        const oldVideoTrack = streamStateRef.current.localStream.getTracks().find(
          (track) => track.kind === 'video'
        );
        if (oldVideoTrack) {
          oldVideoTrack.stop();
          streamStateRef.current.localStream.removeTrack(oldVideoTrack);
          streamStateRef.current.localStream.addTrack(newVideoTrack);
        }
      }
      setLocalStream(streamStateRef.current.localStream);
    } catch (err) {
      console.error('Error switching camera:', err);
      setError('Failed to switch camera');
    }
  };

  // 6. UI RENDERING
  const renderJoinScreen = () => {
    if (!socketIsConnected) {
      return (
        <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <ActivityIndicator size="large" color="#2196F3" />
          <Text style={[styles.input, { color: 'white', textAlign: 'center', marginTop: 10 }]}>
            Reconnecting to server...
          </Text>
        </View>
      );
    }

    return (
      <>
        <TextInput
          style={styles.input}
          placeholder="Enter Room ID"
          value={roomId}
          onChangeText={setRoomId}
          placeholderTextColor="#999"
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        {loading && <ActivityIndicator size="large" color="#2196F3" />}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.createButton]}
            onPress={() => createOrJoinRoom('create')}
            disabled={loading}
          >
            <Text style={styles.buttonText}>Create Room</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.joinButton]}
            onPress={() => createOrJoinRoom('join')}
            disabled={loading}
          >
            <Text style={styles.buttonText}>Join Room</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  };

  const renderHostControls = () => (
    <>
      <Button
        title="Start Streaming"
        onPress={startStream}
        disabled={loading || isStreaming || !streamStateRef.current.localStream}
      />
      <Button title="End Stream" color="red" onPress={endStream} disabled={loading} />
    </>
  );

  const renderStreamingScreen = () => {
    const isStreamValid =
      streamStateRef.current.localStream &&
      streamStateRef.current.localStream.getTracks?.().some(
        (track) => track.enabled && track.readyState === 'live'
      );

    return (
      <>
        {isStreamValid && typeof streamStateRef.current.localStream.toURL === 'function' && (
          <RTCView
            streamURL={streamStateRef.current.localStream.toURL()}
            style={styles.fullScreenVideo}
            objectFit="cover"
            mirror={isFrontCamera}
          />
        )}
        <View style={styles.bottomOverlay}>
          <Button title="Switch Camera" onPress={switchCamera} disabled={loading} />
          <Button title="End Stream" color="red" onPress={endStream} disabled={loading} />
        </View>
      </>
    );
  };

  const renderViewerScreen = () => {
    const remoteStream = Object.values(remoteStreams)[0];
    const isStreamValid =
      remoteStream &&
      remoteStream.getTracks?.().some((track) => track.enabled && track.readyState === 'live');

    return (
      <>
        {isHostStreaming && isStreamValid && typeof remoteStream.toURL === 'function' ? (
          <RTCView streamURL={remoteStream.toURL()} style={styles.fullScreenVideo} />
        ) : (
          <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
            <ActivityIndicator size="large" color="#2196F3" />
            <Text style={{ color: 'white', marginTop: 10 }}>
              {isHostStreaming ? 'Connecting to stream...' : 'Waiting for host to start streaming...'}
            </Text>
          </View>
        )}
        <Button title="Leave Room" color="red" onPress={endStream} disabled={loading} />
      </>
    );
  };

  // Main render
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>🎥 Live Stream App</Text>
      {!joined && renderJoinScreen()}
      {joined && isHost && !isStreaming && renderHostControls()}
      {joined && isHost && isStreaming && renderStreamingScreen()}
      {joined && !isHost && renderViewerScreen()}
      {error && <Text style={styles.errorText}>{error}</Text>}
    </SafeAreaView>
  );
}

// Styles
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
  errorText: { color: 'red', textAlign: 'center', marginVertical: 10 },
});