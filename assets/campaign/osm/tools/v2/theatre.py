# theatre.py -> src/campaign/v2/content_theatre.js
# The pan-able theatre for campaign v2: the front from the Dnipro estuary to the Russian border in Kharkiv oblast,
# Feb 2023 -> Mar 2024. Built from geocoded settlements (Nominatim, (c) OpenStreetMap contributors) placed along the
# line as public maps (DeepState / ISW daily maps, Wikipedia battle articles) showed it. The line is APPROXIMATE:
# a few km accuracy, good enough for a strategic overview, not for navigation.
# The front is assembled from named segments (south -> north); each segment has dated states (the state applies from
# its date until the next one). Snapshots are taken on the 1st of every month and on every state change.
import json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../..'))

SEG = [
  # ---- Kherson: the Dnipro and the Kakhovka reservoir (Kinburn spit Russian-held). Krynky bridgehead from Oct 2023.
  ('dnipro', [
    ('2023-02-06', [[46.53, 31.52], [46.57, 31.75], [46.52, 32.05], [46.56, 32.35], [46.60, 32.52], [46.632, 32.62], [46.655, 32.70], [46.672, 32.75],
                    [46.695, 32.88], [46.718, 32.99], [46.752, 33.10], [46.765, 33.20], [46.772, 33.30], [46.778, 33.37], [46.90, 33.52], [47.03, 33.70],
                    [47.20, 33.90], [47.35, 34.10], [47.47, 34.30], [47.53, 34.50], [47.56, 34.66], [47.52, 34.85], [47.46, 35.00], [47.47, 35.15],
                    [47.52, 35.28], [47.55, 35.32]]),
    ('2023-10-20', [[46.53, 31.52], [46.57, 31.75], [46.52, 32.05], [46.56, 32.35], [46.60, 32.52], [46.632, 32.62], [46.655, 32.70], [46.672, 32.75],
                    [46.695, 32.88], [46.718, 32.99], [46.752, 33.08], [46.739, 33.10], [46.738, 33.135], [46.756, 33.15], [46.765, 33.20], [46.772, 33.30],
                    [46.778, 33.37], [46.90, 33.52], [47.03, 33.70], [47.20, 33.90], [47.35, 34.10], [47.47, 34.30], [47.53, 34.50], [47.56, 34.66],
                    [47.52, 34.85], [47.46, 35.00], [47.47, 35.15], [47.52, 35.28], [47.55, 35.32]]),
  ]),
  # ---- Zaporizhzhia west: Kamianske - Stepove - Mali Shcherbaky (Lobkove / Piatykhatky contested from June 2023)
  ('zap_west', [
    ('2023-02-06', [[47.545, 35.37], [47.528, 35.42], [47.540, 35.465], [47.548, 35.553], [47.535, 35.59], [47.515, 35.62]]),
    ('2023-06-20', [[47.545, 35.37], [47.522, 35.41], [47.505, 35.45], [47.525, 35.49], [47.548, 35.553], [47.535, 35.59], [47.515, 35.62]]),
  ]),
  # ---- Orikhiv - Robotyne - Verbove (the UA campaign's area of responsibility)
  ('orikhiv', [
    ('2023-02-06', [[47.505, 35.64], [47.488, 35.69], [47.484, 35.73], [47.486, 35.77], [47.488, 35.80], [47.486, 35.84], [47.488, 35.88], [47.490, 35.92], [47.486, 35.96], [47.480, 36.00], [47.476, 36.03]]),
    ('2023-06-15', [[47.505, 35.64], [47.488, 35.69], [47.484, 35.73], [47.485, 35.77], [47.484, 35.80], [47.478, 35.83], [47.480, 35.86], [47.483, 35.90], [47.486, 35.96], [47.480, 36.00], [47.476, 36.03]]),
    ('2023-07-15', [[47.505, 35.64], [47.488, 35.69], [47.482, 35.73], [47.480, 35.77], [47.475, 35.80], [47.468, 35.82], [47.466, 35.84], [47.475, 35.87], [47.482, 35.90], [47.486, 35.96], [47.480, 36.00], [47.476, 36.03]]),
    ('2023-08-10', [[47.505, 35.64], [47.488, 35.69], [47.478, 35.73], [47.470, 35.77], [47.458, 35.80], [47.452, 35.82], [47.452, 35.845], [47.462, 35.87], [47.475, 35.90], [47.484, 35.95], [47.480, 36.00], [47.476, 36.03]]),
    ('2023-08-28', [[47.505, 35.64], [47.488, 35.69], [47.478, 35.72], [47.466, 35.76], [47.452, 35.79], [47.438, 35.81], [47.432, 35.83], [47.438, 35.85], [47.448, 35.88], [47.455, 35.92], [47.465, 35.96], [47.475, 36.00], [47.476, 36.03]]),
    ('2023-09-23', [[47.505, 35.64], [47.488, 35.69], [47.478, 35.72], [47.466, 35.76], [47.452, 35.79], [47.438, 35.81], [47.430, 35.83], [47.430, 35.85], [47.436, 35.88], [47.433, 35.92], [47.432, 35.955], [47.445, 35.975], [47.465, 36.00], [47.476, 36.03]]),
    ('2024-01-15', [[47.505, 35.64], [47.488, 35.69], [47.478, 35.72], [47.466, 35.76], [47.452, 35.79], [47.442, 35.81], [47.434, 35.825], [47.432, 35.85], [47.437, 35.88], [47.435, 35.92], [47.436, 35.955], [47.447, 35.975], [47.465, 36.00], [47.476, 36.03]]),
  ]),
  # ---- Polohy / Huliaipole to Levadne - Novodarivka (liberated 12 June 2023)
  ('huliaipole', [
    ('2023-02-06', [[47.50, 36.10], [47.55, 36.18], [47.585, 36.24], [47.62, 36.30], [47.66, 36.42], [47.70, 36.52], [47.79, 36.60], [47.785, 36.66], [47.80, 36.72]]),
    ('2023-06-12', [[47.50, 36.10], [47.55, 36.18], [47.585, 36.24], [47.62, 36.30], [47.66, 36.42], [47.70, 36.52], [47.725, 36.58], [47.735, 36.62], [47.76, 36.68], [47.80, 36.72]]),
  ]),
  # ---- Velyka Novosilka: Neskuchne, Blahodatne, Makarivka (10–11 Jun), Storozheve, Staromaiorske (27 Jul), Urozhaine (16 Aug)
  ('novosilka', [
    ('2023-02-06', [[47.83, 36.76], [47.828, 36.80], [47.835, 36.83], [47.83, 36.86], [47.82, 36.92], [47.80, 36.98]]),
    ('2023-06-11', [[47.81, 36.76], [47.785, 36.775], [47.775, 36.795], [47.79, 36.83], [47.81, 36.88], [47.80, 36.98]]),
    ('2023-07-27', [[47.78, 36.76], [47.745, 36.78], [47.758, 36.81], [47.79, 36.85], [47.80, 36.90], [47.80, 36.98]]),
    ('2023-08-16', [[47.77, 36.76], [47.735, 36.78], [47.738, 36.825], [47.77, 36.86], [47.795, 36.92], [47.80, 36.98]]),
  ]),
  # ---- Vuhledar (held by UA all through) to Novomykhailivka
  ('vuhledar', [
    ('2023-02-06', [[47.78, 37.03], [47.775, 37.08], [47.77, 37.15], [47.765, 37.22], [47.768, 37.25], [47.775, 37.30], [47.80, 37.33], [47.84, 37.40], [47.86, 37.45], [47.86, 37.52]]),
  ]),
  # ---- Marinka (Russian forces claim it 25 Dec 2023) - Krasnohorivka - Nevelske
  ('marinka', [
    ('2023-02-06', [[47.90, 37.52], [47.935, 37.53], [47.948, 37.515], [47.965, 37.50], [47.99, 37.52], [48.02, 37.55], [48.045, 37.565], [48.06, 37.585]]),
    ('2023-12-25', [[47.90, 37.50], [47.925, 37.49], [47.945, 37.475], [47.965, 37.485], [47.99, 37.515], [48.02, 37.55], [48.045, 37.565], [48.06, 37.585]]),
  ]),
  # ---- Avdiivka salient (the RU campaign's area of responsibility)
  ('avdiivka', [
    ('2023-02-06', [[48.066, 37.598], [48.078, 37.63], [48.083, 37.668], [48.087, 37.708], [48.088, 37.738], [48.093, 37.762], [48.100, 37.786], [48.110, 37.807],
                    [48.128, 37.812], [48.146, 37.79], [48.160, 37.776], [48.172, 37.768], [48.180, 37.748], [48.197, 37.744], [48.205, 37.73], [48.214, 37.768],
                    [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
    ('2023-03-25', [[48.066, 37.598], [48.078, 37.63], [48.083, 37.668], [48.087, 37.708], [48.088, 37.738], [48.093, 37.762], [48.100, 37.786], [48.110, 37.807],
                    [48.128, 37.812], [48.146, 37.79], [48.160, 37.776], [48.172, 37.768], [48.180, 37.748], [48.190, 37.722], [48.203, 37.703], [48.215, 37.73],
                    [48.214, 37.768], [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
    ('2023-10-28', [[48.066, 37.598], [48.078, 37.63], [48.083, 37.668], [48.087, 37.708], [48.088, 37.738], [48.093, 37.762], [48.100, 37.786], [48.110, 37.807],
                    [48.128, 37.812], [48.146, 37.79], [48.160, 37.776], [48.172, 37.768], [48.178, 37.745], [48.176, 37.715], [48.188, 37.695], [48.205, 37.69],
                    [48.215, 37.73], [48.214, 37.768], [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
    ('2023-12-04', [[48.066, 37.598], [48.078, 37.63], [48.083, 37.668], [48.087, 37.708], [48.088, 37.738], [48.093, 37.762], [48.105, 37.775], [48.118, 37.778],
                    [48.130, 37.79], [48.146, 37.788], [48.160, 37.776], [48.172, 37.766], [48.178, 37.745], [48.172, 37.71], [48.183, 37.69], [48.195, 37.68],
                    [48.210, 37.70], [48.215, 37.73], [48.214, 37.768], [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
    ('2024-01-22', [[48.066, 37.598], [48.078, 37.63], [48.083, 37.668], [48.087, 37.708], [48.088, 37.738], [48.093, 37.758], [48.105, 37.762], [48.120, 37.765],
                    [48.128, 37.778], [48.146, 37.786], [48.160, 37.774], [48.172, 37.764], [48.178, 37.745], [48.172, 37.71], [48.183, 37.69], [48.192, 37.67],
                    [48.205, 37.68], [48.215, 37.73], [48.214, 37.768], [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
    ('2024-02-10', [[48.066, 37.598], [48.078, 37.63], [48.083, 37.668], [48.087, 37.708], [48.098, 37.722], [48.104, 37.738], [48.115, 37.748], [48.128, 37.755],
                    [48.145, 37.762], [48.155, 37.755], [48.165, 37.745], [48.172, 37.73], [48.172, 37.71], [48.183, 37.69], [48.192, 37.67], [48.205, 37.68],
                    [48.215, 37.73], [48.214, 37.768], [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
    ('2024-02-17', [[48.066, 37.598], [48.078, 37.63], [48.083, 37.668], [48.095, 37.69], [48.110, 37.70], [48.125, 37.705], [48.140, 37.70], [48.155, 37.695],
                    [48.170, 37.685], [48.183, 37.675], [48.195, 37.668], [48.205, 37.68], [48.215, 37.73], [48.214, 37.768], [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
    ('2024-02-27', [[48.066, 37.598], [48.078, 37.63], [48.090, 37.65], [48.100, 37.658], [48.115, 37.655], [48.130, 37.655], [48.145, 37.662], [48.160, 37.660],
                    [48.180, 37.658], [48.195, 37.660], [48.205, 37.68], [48.215, 37.73], [48.214, 37.768], [48.222, 37.80], [48.214, 37.845], [48.214, 37.89]]),
  ]),
  # ---- Horlivka - Toretsk - Niu-York - Mayorsk (static)
  ('toretsk', [
    ('2023-02-06', [[48.24, 37.92], [48.28, 37.92], [48.32, 37.86], [48.34, 37.87], [48.37, 37.895], [48.385, 37.94], [48.40, 37.96], [48.45, 37.96], [48.47, 37.965]]),
  ]),
  # ---- Bakhmut (Russian forces claim it 20 May 2023); Andriivka (15 Sep) and Klishchiivka (17 Sep) liberated
  ('bakhmut', [
    ('2023-02-06', [[48.50, 37.95], [48.53, 37.945], [48.56, 37.96], [48.578, 38.015], [48.595, 38.03], [48.612, 38.02], [48.64, 38.00], [48.66, 38.02], [48.69, 38.03],
                    [48.72, 38.02], [48.74, 38.00], [48.76, 38.06], [48.79, 38.15], [48.81, 38.23]]),
    ('2023-03-01', [[48.50, 37.95], [48.53, 37.945], [48.56, 37.955], [48.575, 37.99], [48.59, 38.00], [48.61, 37.99], [48.63, 37.97], [48.655, 37.98], [48.69, 38.00],
                    [48.72, 38.02], [48.74, 38.00], [48.76, 38.06], [48.79, 38.15], [48.81, 38.23]]),
    ('2023-04-01', [[48.50, 37.95], [48.53, 37.945], [48.56, 37.95], [48.578, 37.97], [48.595, 37.975], [48.615, 37.965], [48.63, 37.95], [48.655, 37.97], [48.69, 37.99],
                    [48.72, 38.02], [48.74, 38.00], [48.76, 38.06], [48.79, 38.15], [48.81, 38.23]]),
    ('2023-05-20', [[48.50, 37.95], [48.53, 37.945], [48.56, 37.945], [48.585, 37.955], [48.60, 37.95], [48.62, 37.95], [48.64, 37.95], [48.66, 37.965], [48.69, 37.99],
                    [48.72, 38.02], [48.74, 38.00], [48.76, 38.06], [48.79, 38.15], [48.81, 38.23]]),
    ('2023-09-17', [[48.49, 37.99], [48.51, 37.985], [48.53, 37.975], [48.55, 37.96], [48.57, 37.95], [48.585, 37.955], [48.60, 37.95], [48.62, 37.95], [48.64, 37.95],
                    [48.66, 37.965], [48.69, 37.99], [48.72, 38.02], [48.74, 38.00], [48.76, 38.06], [48.79, 38.15], [48.81, 38.23]]),
  ]),
  # ---- Siversk - Bilohorivka - Kreminna forest - Makiivka (static)
  ('kreminna', [
    ('2023-02-06', [[48.85, 38.26], [48.89, 38.26], [48.924, 38.235], [48.96, 38.21], [49.00, 38.17], [49.03, 38.14], [49.07, 38.11], [49.10, 38.09], [49.15, 38.06],
                    [49.19, 38.04], [49.21, 38.03], [49.24, 38.02]]),
  ]),
  # ---- Svatove - Kupiansk - the Oskil - the border (Krokhmalne lost early 2024)
  ('kupiansk', [
    ('2023-02-06', [[49.30, 37.97], [49.33, 37.93], [49.38, 37.93], [49.43, 37.92], [49.48, 37.93], [49.52, 37.97], [49.56, 37.94], [49.575, 37.93], [49.60, 37.89],
                    [49.64, 37.93], [49.68, 37.86], [49.72, 37.76], [49.76, 37.74], [49.81, 37.73], [49.85, 37.74], [49.92, 37.86], [49.96, 37.93], [50.05, 38.00], [50.12, 38.03]]),
    ('2024-01-20', [[49.30, 37.97], [49.33, 37.93], [49.38, 37.93], [49.43, 37.92], [49.48, 37.93], [49.52, 37.965], [49.56, 37.92], [49.578, 37.905], [49.60, 37.885],
                    [49.64, 37.925], [49.68, 37.86], [49.72, 37.76], [49.76, 37.74], [49.81, 37.73], [49.85, 37.74], [49.92, 37.86], [49.96, 37.93], [50.05, 38.00], [50.12, 38.03]]),
  ]),
]

def state(seg, date):
    cur = None
    for d, pts in seg:
        if d <= date: cur = pts
    return cur
change = sorted({d for _, seg in SEG for d, _ in seg})
months = [f'{y}-{m:02d}-01' for y in (2023, 2024) for m in range(1, 13) if '2023-03-01' <= f'{y}-{m:02d}-01' <= '2024-03-01']
dates = sorted(set(['2023-02-06'] + months + [d for d in change if d >= '2023-02-06']))
fronts = []
for d in dates:
    line = []
    for _, seg in SEG:
        pts = state(seg, d)
        for p in pts:
            if not line or line[-1] != p: line.append(p)
    fronts.append(dict(date=d, line=line))

RIVERS = [
  dict(name='Dnipro', w=3, pts=[[46.48, 31.95], [46.52, 32.05], [46.56, 32.35], [46.60, 32.52], [46.632, 32.62], [46.655, 32.70], [46.672, 32.75], [46.695, 32.88],
       [46.718, 32.99], [46.752, 33.10], [46.765, 33.20], [46.772, 33.30], [46.778, 33.37], [46.90, 33.52], [47.03, 33.70], [47.20, 33.90], [47.35, 34.10],
       [47.47, 34.30], [47.53, 34.50], [47.56, 34.66], [47.52, 34.85], [47.46, 35.00], [47.47, 35.15], [47.52, 35.28], [47.55, 35.32], [47.63, 35.25],
       [47.75, 35.19], [47.85, 35.10], [48.00, 35.10], [48.20, 35.15], [48.45, 35.07], [48.55, 34.75], [48.62, 34.55]]),
  dict(name='Kakhovka reservoir (drained after 6 Jun 2023)', w=6, pts=[[46.80, 33.42], [46.95, 33.60], [47.10, 33.80], [47.28, 34.00], [47.42, 34.22], [47.52, 34.45], [47.55, 34.70], [47.50, 34.92], [47.48, 35.10], [47.52, 35.25]]),
  dict(name='Siverskyi Donets', w=2, pts=[[50.30, 36.70], [50.05, 36.62], [49.84, 36.69], [49.65, 36.78], [49.45, 36.86], [49.30, 37.10], [49.19, 37.28], [49.10, 37.45],
       [48.99, 37.70], [49.00, 37.88], [48.95, 38.10], [48.924, 38.26], [48.92, 38.42], [48.85, 38.60], [48.75, 39.00], [48.60, 39.40]]),
  dict(name='Oskil', w=2, pts=[[50.35, 37.85], [50.05, 37.75], [49.85, 37.68], [49.71, 37.60], [49.50, 37.56], [49.30, 37.45], [49.17, 37.33]]),
  dict(name='Inhulets', w=1, pts=[[47.60, 33.30], [47.30, 33.10], [47.05, 32.90], [46.75, 32.85], [46.66, 32.75]]),
  dict(name='Vovcha', w=1, pts=[[47.95, 36.80], [48.10, 36.40], [48.30, 35.90], [48.45, 35.40]]),
  dict(name='Mokri Yaly', w=1, pts=[[48.05, 36.95], [47.84, 36.84], [47.70, 36.80], [47.55, 36.76]]),
]
LABELS = [
  *[dict(latlon=ll, text=t, kind='city') for ll, t in [
    ([46.640, 32.614], 'Kherson'), ([46.976, 31.994], 'Mykolaiv'), ([47.851, 35.118], 'Zaporizhzhia'), ([48.468, 35.042], 'Dnipro'), ([46.847, 35.383], 'Melitopol'),
    ([47.255, 35.709], 'Tokmak'), ([46.756, 36.789], 'Berdiansk'), ([47.096, 37.550], 'Mariupol'), ([48.016, 37.801], 'Donetsk'), ([48.306, 38.003], 'Horlivka'),
    ([48.572, 39.297], 'Luhansk'), ([48.739, 37.584], 'Kramatorsk'), ([48.852, 37.606], 'Sloviansk'), ([48.589, 38.002], 'Bakhmut'), ([48.134, 37.747], 'Avdiivka'),
    ([49.713, 37.614], 'Kupiansk'), ([49.191, 37.278], 'Izium'), ([49.992, 36.231], 'Kharkiv'), ([48.980, 37.817], 'Lyman'), ([49.046, 38.218], 'Kreminna'),
    ([49.418, 38.146], 'Svatove'), ([48.948, 38.494], 'Sievierodonetsk'), ([48.917, 38.429], 'Lysychansk'), ([48.277, 37.177], 'Pokrovsk'), ([47.781, 37.246], 'Vuhledar'),
    ([47.844, 36.840], 'Velyka Novosilka'), ([47.666, 36.266], 'Huliaipole'), ([47.575, 35.786], 'Orikhiv'), ([47.443, 35.826], 'Robotyne'), ([46.758, 33.357], 'Nova Kakhovka'),
    ([47.490, 34.660], 'Enerhodar'), ([47.569, 34.392], 'Nikopol'), ([46.747, 33.119], 'Krynky'), ([47.940, 37.502], 'Marinka'), ([48.535, 37.692], 'Kostiantynivka'),
    ([48.587, 37.837], 'Chasiv Yar'), ([48.397, 37.850], 'Toretsk'), ([48.867, 38.090], 'Siversk'), ([47.479, 36.253], 'Polohy'), ([48.127, 37.859], 'Yasynuvata')]],
  *[dict(latlon=ll, text=t, kind='oblast') for ll, t in [
    ([46.95, 33.30], 'KHERSON OBLAST'), ([47.20, 35.80], 'ZAPORIZHZHIA OBLAST'), ([48.25, 37.30], 'DONETSK OBLAST'), ([48.85, 39.10], 'LUHANSK OBLAST'),
    ([49.70, 36.50], 'KHARKIV OBLAST'), ([48.15, 34.70], 'DNIPROPETROVSK OBLAST'), ([47.25, 31.90], 'MYKOLAIV OBLAST')]],
  *[dict(latlon=ll, text=t, kind='river') for ll, t in [
    ([47.30, 34.15], 'Dnipro'), ([49.25, 37.15], 'Siverskyi Donets'), ([49.95, 37.73], 'Oskil'), ([46.62, 32.48], 'Dnipro')]],
]
# country-level news (real events, neutral wording, no people named). Dates are when the event happened / was announced.
EVENTS = [
  ('2023-02-24', 'One year since the start of the full-scale invasion.', None),
  ('2023-03-04', 'Bakhmut: Russian forces close in on the city from three sides; the defenders hold on.', [48.589, 38.002]),
  ('2023-03-28', 'The first Western main battle tanks arrive in Ukraine.', None),
  ('2023-04-26', 'Ukraine receives Western infantry fighting vehicles for new brigades being formed for a counteroffensive.', None),
  ('2023-05-20', 'Bakhmut: Russian forces claim the city after more than nine months of fighting.', [48.589, 38.002]),
  ('2023-06-06', 'The Kakhovka dam is destroyed; floods sweep the lower Dnipro on both banks.', [46.778, 33.37]),
  ('2023-06-08', 'The Ukrainian counteroffensive begins in Zaporizhzhia: armoured attacks south of Orikhiv and towards Velyka Novosilka.', [47.53, 35.87]),
  ('2023-06-11', 'Ukrainian forces liberate Blahodatne, Neskuchne and Makarivka south of Velyka Novosilka.', [47.79, 36.81]),
  ('2023-06-24', 'An armed mutiny by the Wagner group in Russia ends within a day.', None),
  ('2023-07-17', 'Russia withdraws from the Black Sea grain deal; the Crimean bridge is struck again.', None),
  ('2023-07-27', 'Ukrainian forces liberate Staromaiorske.', [47.753, 36.796]),
  ('2023-08-16', 'Ukrainian forces liberate Urozhaine.', [47.749, 36.819]),
  ('2023-08-28', 'Ukraine announces the liberation of Robotyne in Zaporizhzhia.', [47.443, 35.826]),
  ('2023-09-17', 'Ukrainian forces retake Andriivka and Klishchiivka south of Bakhmut.', [48.528, 37.959]),
  ('2023-09-22', 'A missile strike hits the Black Sea Fleet headquarters in Sevastopol.', None),
  ('2023-09-23', 'Ukrainian armour crosses the anti-tank ditch west of Verbove.', [47.436, 35.948]),
  ('2023-10-10', 'Russian forces launch a large offensive on Avdiivka from three directions.', [48.134, 37.747]),
  ('2023-10-17', 'Ukraine strikes airfields at Berdiansk and Luhansk with newly delivered long-range missiles.', [46.756, 36.789]),
  ('2023-10-28', 'Avdiivka: Russian forces take the spoil heap north of the coke plant.', [48.183, 37.713]),
  ('2023-11-01', 'With the counteroffensive culminated, the front settles into positional warfare along its length.', None),
  ('2023-11-17', 'Ukraine confirms its marines hold positions on the left bank of the Dnipro near Krynky.', [46.747, 33.119]),
  ('2023-11-30', 'Ukraine moves to strategic defence and orders fortified lines built along the front.', None),
  ('2023-12-04', 'Avdiivka: the industrial zone south-east of the town falls to Russian forces.', [48.118, 37.792]),
  ('2023-12-25', 'Russian forces claim Marinka; Ukrainian troops pull back to its outskirts.', [47.940, 37.502]),
  ('2023-12-29', 'The largest Russian air attack of the war strikes cities across Ukraine.', None),
  ('2024-01-22', 'Avdiivka: Russian forces break into the southern part of the town.', [48.122, 37.766]),
  ('2024-02-08', 'Ukraine replaces its commander-in-chief.', None),
  ('2024-02-17', 'Ukrainian forces withdraw from Avdiivka to avoid encirclement.', [48.134, 37.747]),
  ('2024-02-24', 'Two years since the start of the full-scale invasion.', None),
  ('2024-02-27', 'Russian forces take Lastochkyne, Stepove and Sieverne west of Avdiivka; the line steadies at Tonenke – Orlivka – Berdychi.', [48.163, 37.645]),
]
SOURCES = [
  dict(title='2023 Ukrainian counteroffensive — Wikipedia', url='https://en.wikipedia.org/wiki/2023_Ukrainian_counteroffensive'),
  dict(title='Battle of Bakhmut — Wikipedia', url='https://en.wikipedia.org/wiki/Battle_of_Bakhmut'),
  dict(title='Destruction of the Kakhovka Dam — Wikipedia', url='https://en.wikipedia.org/wiki/Destruction_of_the_Kakhovka_Dam'),
  dict(title='Battle of Krynky — Wikipedia', url='https://en.wikipedia.org/wiki/Battle_of_Krynky'),
  dict(title='Battle of Marinka — Wikipedia', url='https://en.wikipedia.org/wiki/Battle_of_Marinka'),
  dict(title='Battle of Avdiivka (2023–2024) — Wikipedia', url='https://en.wikipedia.org/wiki/Battle_of_Avdiivka_(2023%E2%80%932024)'),
  dict(title='Battle of Robotyne — Wikipedia', url='https://en.wikipedia.org/wiki/Battle_of_Robotyne'),
  dict(title='ISW: Russian Offensive Campaign Assessments (daily maps)', url='https://www.understandingwar.org/'),
  dict(title='DeepStateMap (front-line map)', url='https://deepstatemap.live/'),
  dict(title='OpenStreetMap / Nominatim (settlement positions, ODbL)', url='https://www.openstreetmap.org/copyright'),
]
th = dict(bbox=[46.2, 31.3, 50.5, 39.7], fronts=fronts, labels=LABELS, rivers=RIVERS,
          events=[dict(date=d, text=t, **({'latlon': ll} if ll else {})) for d, t, ll in EVENTS], sources=SOURCES)
js = ['// GENERATED by assets/campaign/osm/tools/v2/theatre.py — do not edit by hand (edit the generator).',
      '// Theatre for campaign v2: the front line from the Dnipro estuary to the Russian border, Feb 2023 – Mar 2024, as dated',
      '// snapshots (1st of every month + every change). APPROXIMATE (a few km): settlements geocoded with Nominatim (OSM, ODbL) and',
      '// placed along the line as public maps (DeepState, ISW, Wikipedia battle articles) showed it. Events: real, dated, neutral.',
      'export const THEATRE2 = {', f'  bbox: {json.dumps(th["bbox"])},', '  fronts: [']
for f in fronts: js.append(f'    {{ date: {json.dumps(f["date"])}, line: {json.dumps(f["line"])} }},')
js.append('  ],')
for k in ('labels', 'rivers', 'events', 'sources'):
    js.append(f'  {k}: [')
    for x in th[k]: js.append('    ' + json.dumps(x, ensure_ascii=False) + ',')
    js.append('  ],')
js += ['};', '']
open(f'{ROOT}/src/campaign/v2/content_theatre.js', 'w').write('\n'.join(js))
print(len(fronts), 'snapshots', [ (f['date'], len(f['line'])) for f in fronts])
