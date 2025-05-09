import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  ScrollView,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { ActivityIndicator } from 'react-native';
import { RTCView, mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'react-native-webrtc';
import io from 'socket.io-client';

const socket = io('https://streamingbackend-eh65.onrender.com', {
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

const App = () => {
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
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setIsStreaming(true);
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

    socket.on('user-joined', (viewerId) => {
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

      setTimeout(async () => {
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
      }, 500);
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

      {!joined ? (
        <View style={styles.formContainer}>
          <TextInput
            placeholder="Enter Room ID"
            value={roomId}
            onChangeText={setRoomId}
            style={styles.input}
          />
          {loading ? (
            <ActivityIndicator size="large" color="#0000ff" style={styles.loader} />
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
          <Text style={styles.roomText}>Room ID: {roomId}</Text>
          <Text style={styles.roomText}>You are the {isHost ? 'Host' : 'Viewer'}</Text>
          <Text style={styles.roomText}>👁️ Viewers: {viewerCount}</Text>

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
              <View style={styles.controls}>
                <TouchableOpacity style={styles.controlButton} onPress={toggleMute}>
                  <Text style={styles.buttonText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.controlButton} onPress={switchCamera}>
                  <Text style={styles.buttonText}>Switch Camera</Text>
                </TouchableOpacity>
              </View>
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
              {localStream && (
                <View style={styles.controls}>
                  <TouchableOpacity style={styles.controlButton} onPress={toggleMute}>
                    <Text style={styles.buttonText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.controlButton} onPress={switchCamera}>
                    <Text style={styles.buttonText}>Switch Camera</Text>
                  </TouchableOpacity>
                </View>
              )}
              {isStreaming && <Text style={styles.roomText}>👁️ Viewers: {viewerCount}</Text>}
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

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: '#f8f8f8',
    flex: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1a73e8',
    marginBottom: 20,
    textAlign: 'center',
  },
  formContainer: {
    marginTop: 50,
    alignItems: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    width: '80%',
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
    width: '80%',
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
  },
  loader: {
    marginVertical: 20,
  },
  error: {
    color: 'red',
    marginTop: 20,
    fontSize: 14,
  },
  roomInfo: {
    marginTop: 30,
    alignItems: 'center',
  },
  roomText: {
    fontSize: 18,
    marginVertical: 5,
  },
  streamBox: {
    width: '100%',
    position: 'relative',
  },
  fullScreenVideo: {
    width: '100%',
    height: 350,
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