import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { RTCView, mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'react-native-webrtc';
import io from 'socket.io-client';

const socket = io('https://streamalong.live', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

const iceServers = {
  iceServers: [
    {
      urls: 'turn:coturn.streamalong.live:3478?transport=udp',
      username: 'vikram',
      credential: 'vikram',
    },
  ],
};

// Login Form Component
const LoginForm = ({ onLogin, onToggleForm, setError }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = () => {
    if (email === 'vikram' && password === 'Test@123') {
      onLogin();
    } else {
      setError('Invalid email or password');
    }
  };

  return (
    <View style={styles.formContainer}>
      <Text style={styles.formTitle}>Login</Text>
      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        style={styles.input}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <TextInput
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        style={styles.input}
        secureTextEntry
      />
      <TouchableOpacity style={styles.button} onPress={handleLogin}>
        <Text style={styles.buttonText}>Login</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onToggleForm}>
        <Text style={styles.toggleText}>Don't have an account? Register</Text>
      </TouchableOpacity>
    </View>
  );
};

// Register Form Component
const RegisterForm = ({ onRegister, onToggleForm, setError }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleRegister = () => {
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    // Dummy registration (replace with real backend logic)
    if (email && password) {
      onRegister();
    } else {
      setError('Please fill all fields');
    }
  };

  return (
    <View style={styles.formContainer}>
      <Text style={styles.formTitle}>Register</Text>
      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        style={styles.input}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <TextInput
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        style={styles.input}
        secureTextEntry
      />
      <TextInput
        placeholder="Confirm Password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        style={styles.input}
        secureTextEntry
      />
      <TouchableOpacity style={styles.button} onPress={handleRegister}>
        <Text style={styles.buttonText}>Register</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onToggleForm}>
        <Text style={styles.toggleText}>Already have an account? Login</Text>
      </TouchableOpacity>
    </View>
  );
};

// Auth Screen Component
const AuthScreen = ({ onLogin }) => {
  const [showLogin, setShowLogin] = useState(true);
  const [error, setError] = useState('');

  const toggleForm = () => setShowLogin(!showLogin);

  return (
    <View style={styles.authContainer}>
      <Text style={styles.title}>🎥 Live Streaming App</Text>
      {showLogin ? (
        <LoginForm onLogin={onLogin} onToggleForm={toggleForm} setError={setError} />
      ) : (
        <RegisterForm onRegister={onLogin} onToggleForm={toggleForm} setError={setError} />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
};

// Main Screen Component
const MainScreen = () => {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const [viewers, setViewers] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [loading, setLoading] = useState(false);
  const [streamRequest, setStreamRequest] = useState(null);
  const [hasRequestedStream, setHasRequestedStream] = useState(false);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef({});

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      const allGranted = Object.values(granted).every(value => value === PermissionsAndroid.RESULTS.GRANTED);
      if (!allGranted) {
        throw new Error('Permissions not granted');
      }
    }
  };

  useEffect(() => {
    requestPermissions();

    socket.on('room-created', ({ roomId }) => {
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
      setLoading(false);
    });

    socket.on('room-joined', ({ roomId, hostId, isHostStreaming, viewerCount }) => {
      setIsStreaming(true);
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setLoading(false);
    });

    socket.on('room-full', () => {
      setError('Room is full. Cannot join.');
      setLoading(false);
    });

    socket.on('invalid-room', () => {
      setError('Invalid room ID.');
      setLoading(false);
    });

    socket.on('room-exists', () => {
      setError('Room already exists.');
      setLoading(false);
    });

    socket.on('room-info', ({ viewerCount }) => setViewerCount(viewerCount));

    socket.on('user-joined', async (viewerId) => {
      if (!localStreamRef.current || localStreamRef.current.getTracks().length === 0) {
        console.warn('Viewer joined but local stream not ready');
        return;
      }

      const peerConnection = new RTCPeerConnection(iceServers);

      localStreamRef.current.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStreamRef.current);
      });

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: viewerId, candidate: event.candidate });
        }
      };
      peerConnections.current[viewerId] = peerConnection;
      try {
        const offer = await peerConnection.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        });
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', { target: viewerId, sdp: offer });
      } catch (err) {
        console.error('Offer error:', err);
      }
    });

    socket.on('user-left', (viewerId) => {
      setViewers(prev => prev.filter(id => id !== viewerId));
      if (peerConnections.current[viewerId]) {
        peerConnections.current[viewerId].close();
        delete peerConnections.current[viewerId];
      }
    });

    socket.on('host-started-streaming', () => setIsStreaming(true));

    socket.on('ice-candidate', ({ candidate, sender }) => {
      const pc = peerConnections.current[sender] || peerConnectionRef.current;
      if (pc && candidate) {
        pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('offer', async ({ sdp, sender }) => {
      const peerConnection = new RTCPeerConnection(iceServers);
      peerConnection.ontrack = (event) => {
        setRemoteStream(event.streams[0]);
      };
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
        }
      };
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', { target: sender, sdp: answer });
      peerConnectionRef.current = peerConnection;
    });

    socket.on('answer', async ({ sdp, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    socket.on('host-left', () => {
      setError('Host has left the room.');
      setJoined(false);
      setIsStreaming(false);
    });

    socket.on('room-closed', () => {
      setError('Room has been closed.');
      setJoined(false);
      setIsStreaming(false);
    });

    socket.on('stream-request', ({ viewerId }) => {
      if (isHost) {
        setStreamRequest({ viewerId });
        Alert.alert(
          'Stream Request',
          `Viewer ${viewerId} wants to stream. Allow?`,
          [
            {
              text: 'Allow',
              onPress: () => {
                socket.emit('stream-permission', { viewerId, allowed: true });
                setStreamRequest(null);
              },
            },
            {
              text: 'Deny',
              onPress: () => {
                socket.emit('stream-permission', { viewerId, allowed: false });
                setStreamRequest(null);
              },
            },
          ]
        );
      }
    });

    socket.on('stream-permission', ({ allowed }) => {
      if (allowed) {
        startStreaming();
        setHasRequestedStream(false);
      } else {
        setError('Streaming permission denied by host.');
        setHasRequestedStream(false);
      }
    });

    return () => socket.removeAllListeners();
  }, []);

  const createRoom = () => {
    if (roomId.trim() === '') return setError('Please enter a room ID.');
    setLoading(true);
    socket.emit('create-room', roomId);
  };

  const joinRoom = () => {
    if (roomId.trim() === '') return setError('Please enter a room ID.');
    setLoading(true);
    socket.emit('join-room', roomId);
  };

  const requestStreamPermission = () => {
    socket.emit('stream-request', { roomId, viewerId: socket.id });
    setHasRequestedStream(true);
  };

  const startStreaming = async () => {
    try {
      await requestPermissions();
      const stream = await mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      localStreamRef.current = stream;

      peerConnectionRef.current = new RTCPeerConnection(iceServers);
      stream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, stream);
      });

      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Host ICE candidate:', event.candidate);
        }
      };

      socket.emit('host-streaming', roomId);
      setIsStreaming(true);
    } catch (err) {
      console.error('Streaming error:', err);
      setError('Failed to start streaming.');
    }
  };

  const stopStreaming = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    setIsStreaming(false);
    socket.emit('stop-streaming', roomId);
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsStreaming(false);
    setViewers([]);
    setRoomId('');
    setHasRequestedStream(false);
    setTimeout(() => {
      setError('');
    }, 4000);

    localStream?.getTracks().forEach(track => track.stop());
    remoteStream?.getTracks().forEach(track => track.stop());
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(prev => !prev);
    }
  };

  const switchCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current
        .getVideoTracks()
        .find(track => typeof track._switchCamera === 'function');

      if (videoTrack) {
        videoTrack._switchCamera();
        setIsFrontCamera(prev => !prev);
      }
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>🎥 Live Streaming App</Text>
      <View style={styles.mainBox}>
        {joined ? <Text style={styles.roomText}>👁️ {viewerCount}</Text> : null}
        {joined ? <Text style={styles.roomText}>Room ID: {roomId}</Text> : null}
        {joined ? <Text style={styles.roomText}>You are the {isHost ? 'Host' : 'Viewer'}</Text> : null}
      </View>
      {!joined ? (
        <View style={styles.formContainer}>
          <TextInput
            placeholder="Enter Room ID"
            value={roomId}
            onChangeText={setRoomId}
            style={styles.input}
          />
          {loading ? (
            <ActivityIndicator size="large" color="#1a73e8" style={styles.loader} />
          ) : (
            <>
              <TouchableOpacity style={styles.button} onPress={createRoom}>
                <Text style={styles.buttonText}>Create Room</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.button} onPress={joinRoom}>
                <Text style={styles.buttonText}>Join Room</Text>
              </TouchableOpacity>
            </>
          )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      ) : (
        <View style={styles.roomInfo}>
          {isHost && (
            <View style={styles.streamBox}>
              {localStream && (
                <RTCView
                  streamURL={localStream.toURL()}
                  style={styles.fullScreenVideo}
                  objectFit="cover"
                  mirror={isFrontCamera}
                />
              )}
              {isStreaming ? (
                <View style={styles.controls}>
                  <TouchableOpacity style={styles.controlButton} onPress={toggleMute}>
                    <Text style={styles.buttonText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.controlButton} onPress={switchCamera}>
                    <Text style={styles.buttonText}>Switch Camera</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              <View style={styles.streamControls}>
                {!isStreaming ? (
                  <TouchableOpacity style={styles.startStreamingButton} onPress={startStreaming}>
                    <Text style={styles.buttonText}>Start Streaming</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={styles.stopStreamingButton} onPress={stopStreaming}>
                    <Text style={styles.buttonText}>Stop Streaming</Text>
                  </TouchableOpacity>
                )}
              </View>
              {isStreaming && (
                <Text style={styles.streamingText}>🔴 Streaming Live</Text>
              )}
            </View>
          )}

          {!isHost && (
            <View style={styles.streamBox}>
              {isStreaming && remoteStream ? (
                <>
                  <RTCView
                    streamURL={remoteStream.toURL()}
                    style={styles.fullScreenVideo}
                    objectFit="cover"
                    mirror={true}
                  />
                  <Text style={styles.viewingText}>📡 Watching stream...</Text>
                </>
              ) : localStream ? (
                <RTCView
                  streamURL={localStream.toURL()}
                  style={styles.fullScreenVideo}
                  objectFit="cover"
                  mirror={isFrontCamera}
                />
              ) : null}
              {!isStreaming && (
                <TouchableOpacity
                  style={[styles.startStreamingButton, hasRequestedStream && styles.disabledButton]}
                  onPress={requestStreamPermission}
                  disabled={hasRequestedStream}
                >
                  <Text style={styles.buttonText}>
                    {hasRequestedStream ? 'Awaiting Permission...' : 'Request to Stream'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          <TouchableOpacity style={styles.leaveButton} onPress={leaveRoom}>
            <Text style={styles.buttonText}>Leave Room</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
};

// Main App Component
const App = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const handleLogin = () => {
    setIsAuthenticated(true);
  };

  return isAuthenticated ? <MainScreen /> : <AuthScreen onLogin={handleLogin} />;
};

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: '#f0f4f8',
    flexGrow: 1,
  },
  authContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1a73e8',
    marginBottom: 20,
    textAlign: 'center',
  },
  formContainer: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 5,
  },
  formTitle: {
    fontSize: 24,
    fontWeight: '600',
    color: '#333',
    marginBottom: 20,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    width: '100%',
    marginVertical: 10,
    backgroundColor: '#fff',
    fontSize: 16,
  },
  button: {
    backgroundColor: '#1a73e8',
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 8,
    marginVertical: 10,
    width: '100%',
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  toggleText: {
    color: '#1a73e8',
    fontSize: 14,
    marginTop: 10,
  },
  error: {
    color: 'red',
    marginTop: 10,
    fontSize: 14,
    textAlign: 'center',
  },
  loader: {
    marginVertical: 20,
  },
  roomInfo: {
    marginTop: 30,
    alignItems: 'center',
  },
  roomText: {
    fontSize: 18,
    marginVertical: 5,
    color: '#333',
  },
  mainBox: {
    position: 'absolute',
    width: '100%',
    top: 60,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  streamBox: {
    width: '100%',
    position: 'relative',
  },
  fullScreenVideo: {
    width: '100%',
    height: 600,
    backgroundColor: '#000',
    borderRadius: 12,
    marginBottom: 15,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginVertical: 10,
  },
  streamControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    width: '100%',
    marginVertical: 10,
  },
  controlButton: {
    backgroundColor: '#1a73e8',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  startStreamingButton: {
    backgroundColor: '#34a853',
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 8,
    marginHorizontal: 5,
    width: '45%',
    alignItems: 'center',
  },
  stopStreamingButton: {
    backgroundColor: '#ea4335',
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 8,
    marginHorizontal: 5,
    width: '45%',
    alignItems: 'center',
  },
  streamingText: {
    fontSize: 16,
    color: 'green',
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 20,
  },
  viewingText: {
    fontSize: 18,
    color: '#555',
    marginTop: 10,
    textAlign: 'center',
  },
  leaveButton: {
    backgroundColor: '#ea4335',
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 8,
    marginTop: 20,
    width: '80%',
    alignItems: 'center',
  },
  disabledButton: {
    backgroundColor: '#cccccc',
  },
});

export default App;