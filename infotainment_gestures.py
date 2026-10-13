import cv2
import mediapipe as mp

# Init hand tracking
mp_hands = mp.solutions.hands
mp_draw = mp.solutions.drawing_utils
hands = mp_hands.Hands(max_num_hands=1, min_detection_confidence=0.7)

# Window settings
WIDTH, HEIGHT = 1280, 720
cv2.namedWindow("Infotainment", cv2.WINDOW_NORMAL)
cv2.resizeWindow("Infotainment", WIDTH, HEIGHT)

# App states
current_tab = "Music"  # Default tab
mode = "Pointer"       # Pointer or Music
cursor = (WIDTH//2, HEIGHT//2)
pinch_active = False

# Draw UI tabs
def draw_tabs(frame):
    global current_tab
    tabs = ["Music", "Navigation", "Settings", "Calls"]
    x_start = 50
    for tab in tabs:
        color = (0, 255, 0) if tab == current_tab else (200, 200, 200)
        cv2.rectangle(frame, (x_start, 20), (x_start+200, 80), color, -1)
        cv2.putText(frame, tab, (x_start+40, 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
        x_start += 220

# Draw Music tab
def draw_music(frame):
    cv2.putText(frame, "Now Playing:", (100, 150),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    songs = ["Track 1: Shape of You", "Track 2: Believer", "Track 3: Thunder"]
    for i, song in enumerate(songs):
        cv2.putText(frame, song, (120, 220 + i*60),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.9, (200, 200, 200), 2)
    # Volume slider
    cv2.putText(frame, "Volume", (100, 450),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 0), 2)
    cv2.rectangle(frame, (250, 430), (750, 470), (100, 100, 100), 2)
    cv2.rectangle(frame, (250, 430), (500, 470), (0, 255, 0), -1)  # Example 50%

# Draw Navigation tab
def draw_nav(frame):
    cv2.putText(frame, "Navigation:", (100, 150),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    cv2.putText(frame, "Destination: MG Road", (120, 250),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
    cv2.putText(frame, "Turn Right in 300m", (120, 350),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)

# Draw Settings tab
def draw_settings(frame):
    cv2.putText(frame, "Settings:", (100, 150),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    cv2.putText(frame, "Gesture Sensitivity: HIGH", (120, 250),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
    cv2.putText(frame, "Theme: Dark Mode", (120, 350),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)

# Draw Calls tab
def draw_calls(frame):
    cv2.putText(frame, "Incoming Call...", (100, 200),
                cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 3)
    cv2.putText(frame, "John Doe", (120, 300),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
    cv2.rectangle(frame, (100, 400), (300, 480), (0, 255, 0), -1)
    cv2.putText(frame, "Accept", (130, 450),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
    cv2.rectangle(frame, (350, 400), (550, 480), (0, 0, 255), -1)
    cv2.putText(frame, "Reject", (380, 450),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)

# Run loop
cap = cv2.VideoCapture(0)

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break

    frame = cv2.flip(frame, 1)  # Mirror
    frame = cv2.resize(frame, (WIDTH, HEIGHT))

    # Draw tabs
    draw_tabs(frame)

    # Show current tab
    if current_tab == "Music":
        draw_music(frame)
    elif current_tab == "Navigation":
        draw_nav(frame)
    elif current_tab == "Settings":
        draw_settings(frame)
    elif current_tab == "Calls":
        draw_calls(frame)

    # Cursor + gestures
    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = hands.process(frame_rgb)

    if results.multi_hand_landmarks:
        for handLms in results.multi_hand_landmarks:
            mp_draw.draw_landmarks(frame, handLms, mp_hands.HAND_CONNECTIONS)

            # Get finger tip (index = 8, thumb = 4)
            h, w, _ = frame.shape
            x = int(handLms.landmark[8].x * w)
            y = int(handLms.landmark[8].y * h)
            cursor = (x, y)

            # Detect pinch (click)
            thumb_x = int(handLms.landmark[4].x * w)
            thumb_y = int(handLms.landmark[4].y * h)
            dist = abs(x - thumb_x) + abs(y - thumb_y)

            if dist < 50:
                pinch_active = True
                cv2.circle(frame, cursor, 15, (0, 255, 0), -1)  # Green when clicking
            else:
                pinch_active = False
                cv2.circle(frame, cursor, 15, (0, 0, 255), -1)  # Red cursor

    cv2.imshow("Infotainment", frame)

    key = cv2.waitKey(1)
    if key == ord('q'):
        break
    elif key == ord('m'):  # Switch tab manually
        current_tab = "Music"
    elif key == ord('n'):
        current_tab = "Navigation"
    elif key == ord('s'):
        current_tab = "Settings"
    elif key == ord('c'):
        current_tab = "Calls"

cap.release()
cv2.destroyAllWindows()
