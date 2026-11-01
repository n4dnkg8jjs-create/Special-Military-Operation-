"""Shared geometry of the ATGM / FPV set: used by atgm.py (assets) and clips_atgm.py (animations) so the props and the
clips line up exactly.  Pure numpy (no bpy).

Frames
  G  gunner frame  = the gunner soldier's root (on the ground, facing +Z, +X = his left).  The tripod launchers are placed
     relative to it: launcher origin (pedestal axis on the ground, firing direction +Z) at L0[kind] in G.
  L  launcher frame = GLB frame of kornet.glb / stugna.glb (origin = pedestal axis on the ground, +Z = firing direction).
     G -> L: subtract L0 (no rotation).  The `seat` empty of each launcher GLB = the gunner root (-L0 in L): place the
     launcher so that `seat` coincides with the gunner's root and heading.
Both launchers share the gunner's aim pose (atgm_aim / atgm_fire): right eye at EYE, palms on GRIP_R / GRIP_L.
  Kornet: EYE at the 1P45M eyepiece, palms on the two control handles under the guidance device; the TLC rear end
          overhangs the gunner's head (as on the real 9P163M-1).
  Stugna: the gunner kneels behind the remote control unit (PDU) on its own small tripod: palms on the PDU's side
          grips, eye 0.33 m behind its hooded screen; the launcher stands 1.15 m ahead with the R-2 TLC's rear end
          in front of / above the PDU (backblast clear of his head)."""
import numpy as np

EYE = np.array([-0.03, 1.00, 0.32])           # gunner's right eye in the aim pose (G)
TUBE_X, TUBE_Y = -0.03, 1.26                   # TLC axis line (G)
GRIP_R = np.array([-0.19, 0.875, 0.47])        # right palm centre on the control handle (G); handle axis 12 mm further +X
GRIP_L = np.array([0.15, 0.875, 0.47])         # left palm centre (G); handle axis 12 mm further -X
HANDLE_OFF = 0.012                             # palm centre -> handle axis (along the palm normal)

KORNET = dict(
    L0=np.array([-0.03, 0.0, 0.60]),           # pedestal axis on the ground (G): under the sight box, TLC cantilevered forward
    tube_len=1.21, tube_r=0.080, tube_r_end=0.089,
    tube_rear_z=0.30,                          # TLC rear face (G)
    head_y=0.62,                               # tripod head (top of the legs)
    leg_r=0.56,                                # foot radius from the pedestal axis
)
STUGNA = dict(
    L0=np.array([-0.03, 0.0, 1.15]),
    tube_len=1.30, tube_r=0.076, tube_r_end=0.094,
    tube_rear_z=0.55,
    head_y=0.50,
    leg_r=0.60,
    ctrl=np.array([0.0, 0.0, 0.52]),           # remote control unit: its tripod's centre on the ground (G)
)
LEG_ANG = (0.0, 115.0, -115.0)                 # tripod legs: yaw from +Z (deg) - one forward, two rear-outward


def K(kind):
    return KORNET if kind == 'kornet' else STUGNA


def tube_mount(kind):
    """TLC centre on the launcher (launcher frame) + axis direction"""
    k = K(kind)
    zc = k['tube_rear_z'] + k['tube_len'] / 2
    return np.array([TUBE_X, TUBE_Y, zc]) - k['L0'], np.array([0, 0, 1.0])


def g2l(kind, p):
    return np.asarray(p, float) - K(kind)['L0']


def l2g(kind, p):
    return np.asarray(p, float) + K(kind)['L0']


# ---------------------------------------------------------------- loader (atgm_reload) - launcher frame
# The loader's spots are defined relative to the TLC mount (same for both launchers, so the reload clips match):
# root + heading (deg about +Y; 90 = facing +X of the launcher, i.e. standing on the launcher's right side facing it).
# The fresh TLC lies on the ground right in front of him under the cradle (front to his right, like the mounted one); he steps
# to his right and lays the spent one down there pointing away from the launcher (clear of the fresh one, the legs and the gunner).
LOADER_REL = np.array([-0.72, 0.0, -0.10])     # loader root - TLC mount centre (x, -, z), launcher axes
LOADER_HEADING = 90.0
GROUND_REL = np.array([-0.16, 0.0, 0.15])      # fresh TLC on the ground (TLC node position xz) - TLC mount centre; rotation identity
SPENT_REL = np.array([-1.17, 0.0, 0.75])       # spent TLC on the ground - TLC mount centre; rotation SPENT_YAW
SPENT_YAW = -90.0                              # deg about +Y (TLC front pointing -X of the launcher = away from it)


def _mount_xz(kind):
    tc, _ = tube_mount(kind)
    return np.array([tc[0], 0.0, tc[2]])


def loader_root(kind):
    return _mount_xz(kind) + LOADER_REL


def tube_ground(kind):
    """fresh TLC lying on the ground: TLC node position (launcher frame; node rotation = identity, axis +Z)"""
    return _mount_xz(kind) + GROUND_REL + np.array([0, K(kind)['tube_r_end'], 0])


def tube_spent(kind):
    """spent TLC laid down by atgm_reload: TLC node position (launcher frame; node rotation = yaw SPENT_YAW)"""
    return _mount_xz(kind) + SPENT_REL + np.array([0, K(kind)['tube_r_end'], 0])


# TLC the gunner picks up during atgm_setup (and lays down again in atgm_pack): lying on the ground to his right (G)
TUBE_SETUP_G = dict(kornet=np.array([-0.70, 0.0, 0.62]), stugna=np.array([-0.80, 0.0, 0.72]))


def tube_setup(kind):
    return g2l(kind, TUBE_SETUP_G[kind]) + np.array([0, K(kind)['tube_r_end'], 0])


# ---------------------------------------------------------------- back carry
# weapon_socket_back = Spine1 child, see build_soldier.add_sockets: bind-pose world placement
BACK_SOCK_P = np.array([0.06, 1.13, -0.205])
BACK_FWD = np.array([-0.45, 0.89, 0.0])

# folded launcher on the back (outside a slung rifle): column upright, tilted up to the right like the rifle, sight head up behind
# the right shoulder blade (the right hand reaches it over the shoulder), legs down to the left buttock; the eyepiece / handle side
# (natural -Z) against the back, firing side (natural +Z) facing backwards: swinging it over the right shoulder to the front turns
# it 180 deg about the vertical, so it arrives upright in front facing +Z.  natural frame = launcher frame with the legs folded.
FOLDED = dict(
    kornet=dict(top_y=TUBE_Y - 0.04, rear_z=-0.26, top_w=np.array([-0.15, 1.55]), back_z=-0.29),
    stugna=dict(top_y=TUBE_Y + 0.08, rear_z=-0.17, top_w=np.array([-0.15, 1.58]), back_z=-0.29),
)
FOLD_UP = np.array([-0.30, 0.954, 0.0]) / np.linalg.norm([-0.30, 0.954, 0.0])
FOLD_GRAB = dict(      # natural-frame palm points (+ fingers h / palm normal p) used by atgm_setup / atgm_pack
    kornet=dict(R=(np.array([-0.005, TUBE_Y - 0.073, -0.15]), np.array([0, 0, 1.0]), np.array([0, -1.0, 0])),  # right palm on top of the sight box, rear edge
                L=(GRIP_L - KORNET['L0'], None, None)),                                                    # left palm on the left control handle
    stugna=dict(R=(np.array([0.0, 1.165, -0.04]), np.array([0, 0, 1.0]), np.array([0, -1.0, 0])),          # right palm on the TLC saddle post, rear edge
                L=(np.array([0.282, 1.0, 0.03]), np.array([0, -0.3, 1.0]), np.array([-1.0, 0, 0]))),       # left palm on the PN-S unit's left side
)


def folded_world(kind):
    """natural (launcher) frame -> bind-pose world for the folded launcher on the back: returns (R 3x3, t)"""
    f = FOLDED[kind]
    u = FOLD_UP; z = np.array([0, 0, -1.0]); x = np.cross(u, z)
    R = np.stack([x, u, z], 1)
    top_world = np.array([f['top_w'][0], f['top_w'][1], f['back_z'] + f['rear_z']])
    t = top_world - R @ np.array([0, f['top_y'], 0])
    return R, t


def back_frame():
    """weapon_socket_back in the bind pose: (R columns = socket axes in world, origin)"""
    fwd = BACK_FWD / np.linalg.norm(BACK_FWD); up = np.array([0, 0, -1.0])
    xa = np.cross(up, fwd); xa /= np.linalg.norm(xa)
    ya = np.cross(fwd, xa)
    return np.stack([xa, ya, fwd], 1), BACK_SOCK_P.copy()


def folded_nat_to_sock(kind):
    """natural (launcher) frame -> weapon_socket_back frame (the `folded` node's mesh frame): (R, t)"""
    Rw, tw = folded_world(kind)
    Rb, tb = back_frame()
    return Rb.T @ Rw, Rb.T @ (tw - tb)


# ---------------------------------------------------------------- FPV
# drone (fpv_drone.glb): origin = frame centre, +Z forward, +Y up
DRONE = dict(motor_d=0.300, prop_d=0.178, arm_w=0.016, plate_t=0.0055, motor_r=0.0165, motor_h=0.021)
# controller (fpv_controller.glb) is authored in the weapon_socket frame (parent with identity): origin = right palm centre on
# the right handle; the handles run along the socket's grip axis (like a pistol grip), the right fingers wrap round the back of
# the handle, the thumbs lie on the stick face.  CTRL_R maps the radio's natural frame (x = toward the left handle, y = face
# normal (sticks), z = top edge / antenna) into the socket frame.
_h = np.array([0, -0.32, 0.947]); _h /= np.linalg.norm(_h)       # rig.gunR: fingers direction in gun space
_t = np.array([0, 0.947, 0.32]); _t /= np.linalg.norm(_t)        # grip axis (up)
CTRL_R = np.stack([np.array([1.0, 0, 0]), -_h, _t], 1)          # natural x -> +X, natural y (face) -> -h, natural z (top) -> grip axis
CTRL = dict(grip_L=np.array([0.162, 0.0, 0.0]), width=0.17)     # left palm centre (natural frame == socket frame along x)
# goggles: origin = Head joint (bind pose), see atgm.goggles()
